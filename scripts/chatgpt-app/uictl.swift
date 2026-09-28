// Управление приложением ChatGPT.app с macOS: клики, ввод, буфер обмена,
// геометрия окна и поиск сгенерированной картинки на скриншоте окна.
// Собирается в бинарник uictl (см. gpt-image.mjs, оно пересобирает при изменении).
import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { FileHandle.standardError.write("no cmd\n".data(using: .utf8)!); exit(64) }

func fail(_ m: String) -> Never {
  FileHandle.standardError.write((m + "\n").data(using: .utf8)!)
  exit(1)
}

// MARK: - процесс и окно

func chatGPTPid() -> pid_t {
  for app in NSWorkspace.shared.runningApplications
  where app.bundleIdentifier == "com.openai.codex" || app.localizedName == "ChatGPT" {
    return app.processIdentifier
  }
  fail("ChatGPT.app не запущен")
}

func mainWindow() -> AXUIElement {
  let app = AXUIElementCreateApplication(chatGPTPid())
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, "AXMainWindow" as CFString, &v) == .success, let w = v else {
    fail("нет главного окна ChatGPT (проверь доступ в System Settings → Privacy → Accessibility)")
  }
  return (w as! AXUIElement)
}

func windowFrame() -> (CGPoint, CGSize) {
  let w = mainWindow()
  var p = CGPoint.zero, s = CGSize.zero
  var pv: CFTypeRef?, sv: CFTypeRef?
  AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pv)
  AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv)
  if let pv { AXValueGetValue(pv as! AXValue, .cgPoint, &p) }
  if let sv { AXValueGetValue(sv as! AXValue, .cgSize, &s) }
  return (p, s)
}

func windowID() -> CGWindowID {
  let opts = CGWindowListOption(arrayLiteral: .optionAll, .excludeDesktopElements)
  let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list {
    guard (w[kCGWindowOwnerName as String] as? String) == "ChatGPT",
          (w[kCGWindowName as String] as? String) == "ChatGPT",
          (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          ((b["Height"] as? Double) ?? 0) > 200
    else { continue }
    return CGWindowID(w[kCGWindowNumber as String] as? Int ?? 0)
  }
  fail("окно ChatGPT не найдено на экране")
}

// MARK: - ввод

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func click(_ p: CGPoint, button: CGMouseButton = .left, count: Int = 1) {
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
  usleep(150_000)
  let down: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
  let up: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp
  for i in 1...count {
    let d = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); post(d); usleep(50_000)
    let u = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(i)); post(u); usleep(70_000)
  }
}

func keyStroke(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  let d = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
  d?.flags = flags; post(d); usleep(40_000)
  let u = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
  u?.flags = flags; post(u); usleep(50_000)
}

let keyMap: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32,
  "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28,
  "9": 25, "0": 29,
]
func modifiers(_ s: [String]) -> CGEventFlags {
  var f: CGEventFlags = []
  if s.contains("cmd") { f.insert(.maskCommand) }
  if s.contains("shift") { f.insert(.maskShift) }
  if s.contains("alt") { f.insert(.maskAlternate) }
  if s.contains("ctrl") { f.insert(.maskControl) }
  return f
}

/// Поднимает ChatGPT на передний план и ЖДЁТ, пока он там окажется. Без этого
/// события ввода уходят в приложение, которое успело перехватить фокус, — а
/// activate() возвращается раньше, чем система реально переключит фокус.
/// Симптомы несработавшей активации: референс не приложился, Enter не отправил.
@discardableResult
func activate() -> Bool {
  let pid = chatGPTPid()
  for app in NSWorkspace.shared.runningApplications where app.processIdentifier == pid {
    app.activate(options: [])
  }
  for _ in 0..<30 {
    usleep(100_000)
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
      usleep(250_000)  // дать окну домалеваться после переключения
      return true
    }
  }
  return false
}

// MARK: - разбор картинки

struct Bitmap {
  let rep: NSBitmapImageRep
  let w: Int, h: Int
  init(_ path: String) {
    guard let d = FileManager.default.contents(atPath: path), let r = NSBitmapImageRep(data: d) else {
      fail("не читается png: \(path)")
    }
    rep = r; w = r.pixelsWide; h = r.pixelsHigh
  }
  /// Средний цвет ячейки step×step с левым верхним углом (x, y).
  func cell(_ x: Int, _ y: Int, _ step: Int) -> (Double, Double, Double) {
    var r = 0.0, g = 0.0, b = 0.0, n = 0.0
    var yy = y
    while yy < min(y + step, h) {
      var xx = x
      while xx < min(x + step, w) {
        if let c = rep.colorAt(x: xx, y: yy) {
          r += Double(c.redComponent); g += Double(c.greenComponent); b += Double(c.blueComponent); n += 1
        }
        xx += 3
      }
      yy += 3
    }
    return n == 0 ? (0, 0, 0) : (r / n, g / n, b / n)
  }
}

/// Правый край сайдбара. Раньше шли по одной строке на середине высоты, но там
/// лежит список «Recents»: текст пункта начинается уже на x≈20 и принимался за
/// границу (10 сентября 2026). Теперь берём цвет фона сайдбара в его верхнем углу
/// (над первым пунктом меню) и ищем первый x, где цвет отличается от фона сразу
/// на всех девяти опорных строках — так текст, занимающий одну-две строки, не
/// сдвигает границу, а вертикальная граница с областью переписки сдвигает.
func sidebarEdge(_ bmp: Bitmap) -> Int {
  let base = bmp.cell(8, Int(Double(bmp.h) * 0.10), 4)
  let ys = (1...9).map { Int(Double(bmp.h) * 0.30 + Double($0) * Double(bmp.h) * 0.045) }
  var x = 8
  while x < bmp.w / 2 {
    if ys.allSatisfy({ dist(bmp.cell(x, $0, 4), base) > 0.02 }) { return x }
    x += 4
  }
  return 0
}

func dist(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
  max(abs(a.0 - b.0), max(abs(a.1 - b.1), abs(a.2 - b.2)))
}

/// Ищет сгенерированную картинку в окне чата по ЦВЕТНОСТИ: интерфейс ChatGPT
/// (фон, пузырь с промптом, плейсхолдер загрузки, иконки, композер) — строго
/// серый, а иллюстрация цветная. Поэтому ищем связные области насыщенных ячеек
/// и берём самую крупную. Ограничение: заведомо чёрно-белая иллюстрация так не
/// найдётся — в промптах всегда проси палитру.
func findImage(_ bmp: Bitmap, minW: Int, minH: Int) -> (x: Int, y: Int, w: Int, h: Int, stdev: Double, sat: Double)? {
  let step = 8
  let edge = sidebarEdge(bmp)
  // область переписки: без шапки сверху и без композера снизу
  let x0 = edge + 12, x1 = bmp.w - 12
  let y0 = Int(Double(bmp.h) * 0.06), y1 = Int(Double(bmp.h) * 0.86)
  guard x1 - x0 > 100, y1 - y0 > 100 else { return nil }

  let cols = (x1 - x0) / step, rows = (y1 - y0) / step
  guard cols > 0, rows > 0 else { return nil }
  var colorful = [Bool](repeating: false, count: cols * rows)
  for r in 0..<rows {
    for c in 0..<cols {
      let (cr, cg, cb) = bmp.cell(x0 + c * step, y0 + r * step, step)
      let hi = max(cr, max(cg, cb)), lo = min(cr, min(cg, cb))
      let sat = hi <= 0.001 ? 0 : (hi - lo) / hi
      // цветная ячейка ИЛИ светлая: инфографика на белом фоне почти не насыщена,
      // а по яркости от тёмного интерфейса отличается сильно. Порог 0.55 выше,
      // чем даёт строка белого текста на тёмном фоне (глифы занимают меньше
      // трети ячейки), поэтому абзацы ответа в кандидаты не попадают.
      colorful[r * cols + c] = sat > 0.06 || hi > 0.55
    }
  }

  // связные компоненты (4-связность) цветных ячеек. Пузырь с промптом пользователя
  // в новом интерфейсе ChatGPT синий, то есть тоже «цветной», и по площади спорит с
  // картинкой — из-за него скрипт «находил» картинку раньше, чем она нарисована.
  // Разводим их двумя признаками: пузырь прижат к ПРАВОМУ краю колонки, а ответ с
  // картинкой — к левому; и ответ всегда ниже промпта.
  // Порог 0.25, а не 0.15: с сентября 2026 колонка переписки уже и центрирована,
  // картинка начинается на ~17% ширины области, пузырь промпта — на ~37%.
  let maxLeftOffset = Int(Double(x1 - x0) * 0.25)
  var seen = [Bool](repeating: false, count: cols * rows)
  var best: (Int, Int, Int, Int)? = nil
  var bestKey = (-1, 0)  // (нижняя граница, площадь) — площадь только для развязки
  for r in 0..<rows {
    for c in 0..<cols where colorful[r * cols + c] && !seen[r * cols + c] {
      var stack = [(r, c)]
      seen[r * cols + c] = true
      var minR = r, maxR = r, minC = c, maxC = c
      while let (cr, cc) = stack.popLast() {
        minR = min(minR, cr); maxR = max(maxR, cr)
        minC = min(minC, cc); maxC = max(maxC, cc)
        for (dr, dc) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
          let nr = cr + dr, nc = cc + dc
          guard nr >= 0, nr < rows, nc >= 0, nc < cols else { continue }
          let i = nr * cols + nc
          if colorful[i] && !seen[i] { seen[i] = true; stack.append((nr, nc)) }
        }
      }
      let w = (maxC - minC + 1) * step, h = (maxR - minR + 1) * step
      guard w >= minW, h >= minH, minC * step <= maxLeftOffset else { continue }
      let key = (maxR, w * h)
      if key > bestKey { bestKey = key; best = (minR, maxR, minC, maxC) }
    }
  }
  guard let (minR, maxR, minC, maxC) = best else { return nil }
  let bx = x0 + minC * step, by = y0 + minR * step
  let bw = (maxC - minC + 1) * step, bh = (maxR - minR + 1) * step
  guard bw >= minW, bh >= minH else { return nil }

  var bright: [Double] = []
  var satSum = 0.0
  var yy = by
  while yy < by + bh {
    var xx = bx
    while xx < bx + bw {
      if let c = bmp.rep.colorAt(x: min(xx, bmp.w - 1), y: min(yy, bmp.h - 1)) {
        bright.append(Double(c.brightnessComponent))
        satSum += Double(c.saturationComponent)
      }
      xx += 12
    }
    yy += 12
  }
  guard bright.count > 4 else { return nil }
  let mean = bright.reduce(0, +) / Double(bright.count)
  let stdev = (bright.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(bright.count)).squareRoot()
  return (bx, by, bw, bh, stdev, satSum / Double(bright.count))
}

// MARK: - команды

switch cmd {
case "frame":
  let (p, s) = windowFrame()
  print("\(Int(p.x)) \(Int(p.y)) \(Int(s.width)) \(Int(s.height))")

case "winid":
  print(windowID())

case "activate":
  if !activate() { fail("не удалось вывести ChatGPT на передний план") }

case "geometry":  // geometry x y w h — нормализует окно, печатает фактическую рамку
  let w = mainWindow()
  var p = CGPoint(x: Double(args[1])!, y: Double(args[2])!)
  var s = CGSize(width: Double(args[3])!, height: Double(args[4])!)
  AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &s)!)
  usleep(200_000)
  AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &p)!)
  usleep(300_000)
  let (fp, fs) = windowFrame()
  print("\(Int(fp.x)) \(Int(fp.y)) \(Int(fs.width)) \(Int(fs.height))")

case "click", "rclick", "dclick", "tclick":
  // dclick выделяет слово целиком, tclick — абзац: так курсор и выделение
  // ставятся по границам текста, а не по пикселю, куда попал клик «на глаз».
  click(CGPoint(x: Double(args[1])!, y: Double(args[2])!),
        button: cmd == "rclick" ? .right : .left,
        count: cmd == "dclick" ? 2 : (cmd == "tclick" ? 3 : 1))

case "move":  // move <x> <y> — навести курсор; scroll идёт в окно под курсором
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
               mouseCursorPosition: CGPoint(x: Double(args[1])!, y: Double(args[2])!),
               mouseButton: .left))

case "scroll":  // scroll <dy> — отрицательное значение прокручивает вниз
  let dy = Int32(args[1])!
  post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
               wheel1: dy, wheel2: 0, wheel3: 0))

case "key":
  guard let kc = keyMap[args[1].lowercased()] else { fail("неизвестная клавиша \(args[1])") }
  keyStroke(kc, modifiers(Array(args.dropFirst(2))))

case "paste":  // paste <text> — через буфер обмена, иначе кириллица теряется
  let pb = NSPasteboard.general
  pb.clearContents()
  pb.setString(args[1], forType: .string)
  usleep(200_000)
  keyStroke(9, .maskCommand)

case "pastehtml":  // pastehtml <file.html> — кладёт в буфер РАЗМЕТКУ и вставляет
  // Редакторы вроде Medium принимают public.html и сами разворачивают его в свои
  // блоки: заголовки, списки, жирный, ссылки. Это единственный способ перенести
  // форматирование целиком, не набирая абзацы по одному.
  let html = try! String(contentsOfFile: args[1], encoding: .utf8)
  let pbH = NSPasteboard.general
  pbH.clearContents()
  pbH.declareTypes([.html, .string], owner: nil)
  pbH.setString(html, forType: .html)
  pbH.setString(html.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression),
                forType: .string)
  usleep(250_000)
  keyStroke(9, .maskCommand)

case "pastefile":  // pastefile <path> — кладёт картинку в буфер и вставляет в композер
  let url = URL(fileURLWithPath: args[1])
  guard let img = NSImage(contentsOf: url) else { fail("не открывается файл \(args[1])") }
  let pb = NSPasteboard.general
  pb.clearContents()
  pb.writeObjects([img])
  usleep(300_000)
  keyStroke(9, .maskCommand)

case "savepng":  // savepng <path> — записывает картинку из буфера обмена
  let pb = NSPasteboard.general
  if let d = pb.data(forType: .png) {
    try! d.write(to: URL(fileURLWithPath: args[1])); print(d.count)
  } else if let d = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: d),
            let png = rep.representation(using: .png, properties: [:]) {
    try! png.write(to: URL(fileURLWithPath: args[1])); print(png.count)
  } else {
    fail("в буфере обмена нет картинки")
  }

case "shot":  // shot <path> — снимок окна; печатает "x y w h scale"
  let id = windowID()
  let (p, s) = windowFrame()
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  task.arguments = ["-x", "-o", "-l", String(id), args[1]]
  try! task.run(); task.waitUntilExit()
  guard task.terminationStatus == 0 else { fail("screencapture упал") }
  let bmp = Bitmap(args[1])
  let scale = Double(bmp.w) / Double(s.width)
  print("\(Int(p.x)) \(Int(p.y)) \(Int(s.width)) \(Int(s.height)) \(scale)")

case "findimage":  // findimage <png> <originX> <originY> <scale> <minW> <minH>
  let bmp = Bitmap(args[1])
  let ox = Double(args[2])!, oy = Double(args[3])!, scale = Double(args[4])!
  let minW = Int(Double(args[5])! * scale), minH = Int(Double(args[6])! * scale)
  guard let f = findImage(bmp, minW: minW, minH: minH) else { print("none"); exit(0) }
  let cx = ox + (Double(f.x) + Double(f.w) / 2) / scale
  let cy = oy + (Double(f.y) + Double(f.h) / 2) / scale
  // логические размеры + центр для правого клика + разброс яркости + насыщенность
  print("\(Int(Double(f.w) / scale)) \(Int(Double(f.h) / scale)) \(Int(cx)) \(Int(cy)) \(String(format: "%.4f", f.stdev)) \(String(format: "%.4f", f.sat))")

case "sidebar":  // sidebar <png> <originX> <scale> — левый край области переписки в логических координатах
  let bmpS = Bitmap(args[1])
  let oxS = Double(args[2])!, scaleS = Double(args[3])!
  print(Int(oxS + Double(sidebarEdge(bmpS)) / scaleS))

case "clearclip":
  NSPasteboard.general.clearContents()

default:
  fail("неизвестная команда \(cmd)")
}
