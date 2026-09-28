#!/usr/bin/env node
// Прочитать URL глазами залогиненного Chrome и вернуть текст страницы.
//
// Зачем так: Reddit не отдаёт JSON ни curl'у, ни WebFetch (прилетает HTML-заглушка),
// а расширение Claude in Chrome в этом браузере не работает. Зато сам Chrome
// залогинен, и его .json-эндпоинты открываются как обычный текст — остаётся открыть
// вкладку, выделить всё (cmd+a), скопировать (cmd+c) и забрать из буфера обмена.
//
//   node scripts/reddit/rget.mjs "https://www.reddit.com/r/languagelearning/new/.json?limit=25"
//   node scripts/reddit/rget.mjs --keep <url>     # не закрывать вкладку
//
// На выходе — тело страницы в stdout. Буфер обмена при этом затирается (как и в
// gpt-image.mjs), это ожидаемо.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const UICTL = path.join(ROOT, 'scripts/chatgpt-app/uictl')

const osa = (s) => execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim()
const ui = (...a) => execFileSync(UICTL, a, { encoding: 'utf8' })
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function chromeRead(url, { keep = false, settle = 1200, timeout = 30000 } = {}) {
  osa('tell application "Google Chrome" to activate')
  osa(`tell application "Google Chrome" to make new tab at end of tabs of window 1 ` +
      `with properties {URL:${JSON.stringify(url)}}`)

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    sleep(400)
    let loading = 'true'
    try {
      loading = osa('tell application "Google Chrome" to get loading of active tab of window 1')
    } catch { /* вкладка ещё не готова — ждём дальше */ }
    if (loading === 'false') break
  }
  sleep(settle)

  // cmd+a / cmd+c уходят в приложение на переднем плане, поэтому Chrome
  // активируется ещё раз: за время загрузки фокус мог перехватить кто угодно.
  osa('tell application "Google Chrome" to activate')
  sleep(250)
  ui('key', 'a', 'cmd')
  sleep(200)
  ui('key', 'c', 'cmd')
  sleep(350)
  const text = execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  if (!keep) {
    try { osa('tell application "Google Chrome" to close active tab of window 1') } catch {}
  }
  return text
}

export function chromeJson(url, opts) {
  const raw = chromeRead(url, opts)
  // Начало документа — самая ранняя из скобок: у листингов тредов ответ начинается
  // с '[', и ориентироваться только на '{' нельзя — он найдётся внутри массива.
  const starts = ['{', '['].map((c) => raw.indexOf(c)).filter((i) => i >= 0)
  const s = starts.length ? Math.min(...starts) : 0
  try {
    return JSON.parse(raw.slice(s))
  } catch {
    throw new Error('не JSON — скорее всего разлогинило или страница отдала HTML:\n' + raw.slice(0, 400))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const url = args.find((a) => !a.startsWith('--'))
  if (!url) {
    console.error('usage: rget.mjs [--keep] <url>')
    process.exit(64)
  }
  process.stdout.write(chromeRead(url, { keep }))
}
