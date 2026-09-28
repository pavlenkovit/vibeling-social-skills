#!/usr/bin/env node
// Прочитать страницу threads.com глазами залогиненного Chrome.
//
// То же, что scripts/reddit/rget.mjs, с двумя отличиями:
//   1. Threads — SPA, лента дорисовывается после onload, поэтому settle по
//      умолчанию 6 секунд, а не 1.2. С коротким settle возвращается содержимое
//      предыдущей вкладки, и это молча выглядит как «поиск ничего не нашёл».
//   2. Кроме текста забираем HTML-флейвор буфера обмена (`the clipboard as
//      «class HTML»`). В нём лежат href'ы, а значит — постоянные ссылки на посты
//      (`/@user/post/<code>`), которых в plain text нет вообще. Без них не на что
//      ссылаться в журнале и некуда возвращаться за ответами.
//
//   node scripts/threads/tget.mjs "<url>"            # текст
//   node scripts/threads/tget.mjs --html "<url>"     # разметка
//   node scripts/threads/tget.mjs --active           # то, что открыто сейчас
//   node scripts/threads/tget.mjs --scroll 3 "<url>" # домотать ленту вниз
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const UICTL = path.join(ROOT, 'scripts/chatgpt-app/uictl')

const osa = (s) => execFileSync('osascript', ['-e', s], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim()
const ui = (...a) => execFileSync(UICTL, a, { encoding: 'utf8' })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function clipboardHtml() {
  // osascript печатает «data HTML<hex>» — это UTF-8 разметка в hex.
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

// bounds окна Chrome — это {слева, сверху, справа, снизу} в логических точках.
export function winBounds() {
  return osa('tell application "Google Chrome" to get bounds of window 1')
    .split(',').map((n) => parseInt(n.trim(), 10))
}

export function chromeGrab(url, { settle = 6000, keep = false, scroll = 0, timeout = 30000 } = {}) {
  osa('tell application "Google Chrome" to activate')
  if (url) {
    osa('tell application "Google Chrome" to make new tab at end of tabs of window 1 ' +
        `with properties {URL:${JSON.stringify(url)}}`)
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
  for (let i = 0; i < scroll; i++) {
    // Курсор надо сначала завести в окно: scroll уходит в окно под курсором.
    const [l, t, r, b] = winBounds()
    ui('move', String(Math.round((l + r) / 2)), String(Math.round((t + b) / 2)))
    ui('scroll', '-700')
    sleep(1500)
  }

  // Буфер чистится перед копированием: если страница ещё не отрисовалась, cmd+c
  // ничего не кладёт, и pbpaste молча вернёт содержимое ПРЕДЫДУЩЕЙ страницы.
  // Это самая опасная ошибка здесь — она не выглядит как ошибка.
  // На странице поста Threads сам ставит фокус в поле ответа, и тогда cmd+a
  // выделяет пустой composer, а не страницу. Снимаем фокус кликом в пустую
  // полосу между боковым меню и колонкой контента.
  {
    const [l, t, , b] = winBounds()
    ui('click', String(l + 120), String(Math.round((t + b) / 2)))
    sleep(300)
  }

  let text = ''
  let html = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    ui('clearclip')
    sleep(200)
    ui('key', 'a', 'cmd')
    sleep(250)
    ui('key', 'c', 'cmd')
    sleep(500)
    text = execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    html = clipboardHtml()
    if (text.trim().length > 40) break
    sleep(3000)
  }

  if (url && !keep) {
    try { osa('tell application "Google Chrome" to close active tab of window 1') } catch {}
  }
  return { text, html, url: url || osa('tell application "Google Chrome" to get URL of active tab of window 1') }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const wantHtml = args.includes('--html')
  const active = args.includes('--active')
  const si = args.indexOf('--scroll')
  const scroll = si >= 0 ? Number(args[si + 1]) : 0
  const url = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--scroll')
  if (!url && !active) {
    console.error('usage: tget.mjs [--html] [--scroll N] <url> | --active')
    process.exit(64)
  }
  const got = chromeGrab(active ? null : url, { scroll, keep: active })
  process.stdout.write(wantHtml ? got.html : got.text)
}
