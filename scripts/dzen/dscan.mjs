#!/usr/bin/env node
// Разведка по dzen.ru: поиск чужих статей, чтение статьи с комментариями,
// неотвеченные комментарии под своими статьями.
//
//   node scripts/dzen/dscan.mjs search "как учить английские слова" [--max-age 30] [--scroll 2]
//   node scripts/dzen/dscan.mjs article https://dzen.ru/a/CODE
//   node scripts/dzen/dscan.mjs comments https://dzen.ru/a/CODE   # только блок обсуждения
//   node scripts/dzen/dscan.mjs mine                              # комментарии под нашими статьями
//
// Ссылки на статьи живут только в HTML: карточка выдачи это блок
// data-testid="feed-row", внутри которого лежит <a href="https://dzen.ru/a/CODE">,
// а текстом идут канал, возраст, заголовок и начало статьи.
import { chromeGrab, scrollBy } from './dget.mjs'

const STUDIO = 'https://dzen.ru/profile/editor/vital_pavlenko'
const ARTICLE = /href="https:\/\/dzen\.ru\/a\/([A-Za-z0-9_-]+)/

const stripTags = (s) =>
  s.replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.trim()).filter(Boolean)

// «11 часов назад» / «1 день назад» / «5 месяцев назад» / «2 года назад» / «14 мин»
export function ageDays(token) {
  const m = token.match(/(\d+)\s*(мин|час|ч|день|дня|дней|д|недел|мес|год|года|лет)/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  if (unit.startsWith('мин')) return n / 1440
  if (unit === 'час' || unit === 'ч') return n / 24
  if (unit.startsWith('д')) return n
  if (unit.startsWith('недел')) return n * 7
  if (unit.startsWith('мес')) return n * 30
  return n * 365
}

export function parseCards(html) {
  const out = []
  const seen = new Set()
  for (const block of html.split('data-testid="feed-row"').slice(1)) {
    const m = block.match(ARTICLE)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    const lines = stripTags(block).filter((l) => !l.startsWith('style="') && !l.startsWith('<'))
    if (lines.length < 3) continue
    const channel = lines[0]
    // Строка возраста это «5 лет назад» или голое «11 часов»; «593 читали» рядом
    // выглядит похоже, поэтому сначала ищем «назад», и только потом голую длительность.
    const isAge = (l) => /назад/i.test(l) || /^·?\s*\d+\s*(мин|час|ч|дн|дня|день)\.?$/i.test(l)
    const ai = lines.findIndex(isAge)
    const age = ai >= 0 ? lines[ai].replace(/^·\s*/, '') : ''
    const title = lines[ai >= 0 ? ai + 1 : 1] || ''
    const preview = lines.slice(ai >= 0 ? ai + 2 : 2).join(' ').slice(0, 300)
    out.push({
      channel,
      title,
      age,
      age_d: ageDays(age),
      url: `https://dzen.ru/a/${m[1]}`,
      preview,
    })
  }
  return out
}

/** Хвост страницы статьи начиная с «Комментарии N» и до рекламы/рекомендаций. */
export function commentsPart(text) {
  const i = text.search(/Комментари(и|й|ев)\s*\d/)
  if (i < 0) return ''
  let tail = text.slice(i)
  const end = tail.search(/\nРекомендуем почитать|\nПодписаться\n/)
  return (end > 0 ? tail.slice(0, end) : tail).replace(/\n{3,}/g, '\n\n')
}

function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const flag = (name, def) => {
    const i = args.indexOf('--' + name)
    return i >= 0 ? args[i + 1] : def
  }
  const scroll = Number(flag('scroll', 0))

  if (cmd === 'search') {
    const q = args[1]
    if (!q) { console.error('usage: dscan.mjs search "<запрос>" [--max-age D] [--scroll N]'); process.exit(64) }
    const url = 'https://dzen.ru/search?query=' + encodeURIComponent(q) +
                '&type=article&type_filter=article%2Cbrief'
    const { html } = chromeGrab(url, { scroll, settle: 8000 })
    const maxAge = Number(flag('max-age', 0))
    let cards = parseCards(html)
    if (maxAge) cards = cards.filter((c) => c.age_d !== null && c.age_d <= maxAge)
    console.log(`# поиск статей: ${q}`)
    for (const c of cards) {
      console.log(`\n— ${c.channel} · ${c.age}`)
      console.log(`  ${c.title}`)
      console.log(`  ${c.url}`)
      if (c.preview) console.log(`  ${c.preview}`)
    }
    console.log(`\n[${cards.length} статей]`)
  } else if (cmd === 'article') {
    const url = args[1]
    if (!url) { console.error('usage: dscan.mjs article <url>'); process.exit(64) }
    const { text } = chromeGrab(url, { scroll: 1, settle: 8000 })
    console.log(text.replace(/\n{3,}/g, '\n\n'))
  } else if (cmd === 'comments') {
    const url = args[1]
    if (!url) { console.error('usage: dscan.mjs comments <url>'); process.exit(64) }
    // Комментарии подгружаются, когда до них домотали, поэтому идём вниз с запасом.
    // Захват иногда приносит только рекламный iframe (см. dget.mjs) — тогда повторяем.
    let part = ''
    for (let i = 0; i < 3 && !part; i++) {
      const { text } = chromeGrab(url, { scroll: 6, settle: i ? 10000 : 8000 })
      part = commentsPart(text)
    }
    console.log(part || '[комментариев не видно — возможно, их нет или блок не догрузился]')
  } else if (cmd === 'mine') {
    const { text } = chromeGrab(`${STUDIO}/comments`, { scroll: 0, settle: 8000 })
    console.log(text.replace(/\n{3,}/g, '\n\n').slice(0, 8000))
  } else {
    console.error(`usage:
  dscan.mjs search "<запрос>" [--max-age D] [--scroll N]
  dscan.mjs article <url>
  dscan.mjs comments <url>
  dscan.mjs mine`)
    process.exit(64)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
