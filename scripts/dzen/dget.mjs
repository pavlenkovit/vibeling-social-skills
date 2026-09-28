#!/usr/bin/env node
// Прочитать страницу dzen.ru глазами залогиненного Chrome.
//
// То же, что scripts/threads/tget.mjs, с двумя отличиями под Дзен:
//   1. В самом верху статьи висит рекламный блок в кросс-доменном iframe. Если
//      скопировать страницу сразу, cmd+a уходит внутрь него, и на выходе
//      получается один рекламный текст вместо статьи. Поэтому перед копированием
//      лента проматывается на экран вниз, а клик ставится в пустое поле слева от
//      колонки контента.
//   2. Статья и комментарии лежат на одной странице: комментарии идут после текста
//      («Комментарии N», «Написать комментарий», дальше ветки), поэтому одного
//      захвата хватает и на статью, и на обсуждение.
//
//   node scripts/dzen/dget.mjs "<url>"            # текст
//   node scripts/dzen/dget.mjs --html "<url>"     # разметка (в ней ссылки на статьи)
//   node scripts/dzen/dget.mjs --scroll 3 "<url>" # домотать ленту вниз
//   node scripts/dzen/dget.mjs --active           # то, что открыто сейчас
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const UICTL = path.join(ROOT, 'scripts/chatgpt-app/uictl')

const osa = (s) => execFileSync('osascript', ['-e', s], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim()
const ui = (...a) => execFileSync(UICTL, a, { encoding: 'utf8' })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function clipboardHtml() {
  let raw
  try {
    raw = osa('the clipboard as «class HTML»')
  } catch {
    return ''
  }
  const hex = raw.replace(/^«data HTML/, '').replace(/»$/, '').trim()
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return ''
  return Buffer.from(hex, 'hex').toString('utf8')
}

export function winBounds() {
  return osa('tell application "Google Chrome" to get bounds of window 1')
    .split(',').map((n) => parseInt(n.trim(), 10))
}

/** Промотать открытую страницу: положительное вверх, отрицательное вниз. */
export function scrollBy(steps, px = 700) {
  const [l, t, r, b] = winBounds()
  ui('move', String(Math.round((l + r) / 2)), String(Math.round((t + b) / 2)))
  for (let i = 0; i < Math.abs(steps); i++) {
    ui('scroll', String(steps > 0 ? px : -px))
    sleep(700)
  }
}

export function chromeGrab(url, { settle = 7000, keep = false, scroll = 1, timeout = 30000 } = {}) {
  osa('tell application "Google Chrome" to activate')
  if (url) {
    // Навигация в ТЕКУЩЕЙ вкладке, а не в новой: в свежей вкладке Дзена фокус
    // остаётся внутри рекламного iframe, и cmd+a копирует только рекламу.
    osa('tell application "Google Chrome" to set URL of active tab of window 1 to ' +
        JSON.stringify(url))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      sleep(400)
      let loading = 'true'
      try {
        loading = osa('tell application "Google Chrome" to get loading of active tab of window 1')
      } catch { /* вкладка ещё не готова */ }
      if (loading === 'false') break
    }
  }
  sleep(settle)

  osa('tell application "Google Chrome" to activate')
  sleep(250)
  // Первый экран статьи занят рекламным iframe — уходим из него прокруткой.
  if (scroll) scrollBy(-scroll)
  sleep(800)

  // Клик в пустую полосу между боковым меню и колонкой контента: снимает фокус с
  // рекламы, при этом ничего не открывает.
  // Кликать надо дважды с паузой: в свежей вкладке фокус успевает уехать в рекламный
  // iframe уже после первого клика, и тогда cmd+a выделяет рекламу, а не страницу.
  {
    const [l, t, , b] = winBounds()
    const x = String(l + 150)
    const y = String(Math.round((t + b) / 2))
    ui('click', x, y)
    sleep(700)
    ui('click', x, y)
    sleep(500)
  }

  // Признак того, что скопировалась страница, а не рекламный iframe: в шапке Дзена
  // всегда есть поиск «Найти в Дзене». По длине это не отличить — рекламный блок
  // тоже даёт несколько сотен символов и молча проходит проверку на размер.
  const looksLikePage = (t) => t.includes('Найти в Дзене') || t.trim().length > 2000

  let text = ''
  let html = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      // Фокус иногда остаётся в рекламе и после клика. Помогает не повтор одного и
      // того же клика, а несколько по разной высоте плюс перезагрузка на третьей попытке.
      if (attempt === 3 && url) {
        osa('tell application "Google Chrome" to reload active tab of window 1')
        sleep(6000)
        if (scroll) scrollBy(-scroll)
      }
      const [l, t2, , b] = winBounds()
      for (const k of [0.35, 0.6, 0.8]) {
        ui('click', String(l + 150), String(Math.round(t2 + (b - t2) * k)))
        sleep(400)
      }
      sleep(500)
    }
    ui('clearclip')
    sleep(200)
    ui('key', 'a', 'cmd')
    sleep(250)
    ui('key', 'c', 'cmd')
    sleep(600)
    text = execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    html = clipboardHtml()
    if (looksLikePage(text)) break
    sleep(2000)
  }

  // Вкладку не закрываем: мы ходим по Дзену в одной и той же, см. навигацию выше.
  return { text, html, url: url || osa('tell application "Google Chrome" to get URL of active tab of window 1') }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const wantHtml = args.includes('--html')
  const active = args.includes('--active')
  const si = args.indexOf('--scroll')
  const scroll = si >= 0 ? Number(args[si + 1]) : 1
  const url = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--scroll')
  if (!url && !active) {
    console.error('usage: dget.mjs [--html] [--scroll N] <url> | --active')
    process.exit(64)
  }
  const got = chromeGrab(active ? null : url, { scroll, keep: active })
  process.stdout.write(wantHtml ? got.html : got.text)
}
