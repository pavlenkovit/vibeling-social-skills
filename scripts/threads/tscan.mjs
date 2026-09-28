#!/usr/bin/env node
// Разведка по threads.com: поиск свежих тредов, чтение треда, свои ответы.
//
//   node scripts/threads/tscan.mjs search "учу сербский" [--top] [--max-age 24] [--scroll 2]
//   node scripts/threads/tscan.mjs post https://www.threads.com/@user/post/CODE
//   node scripts/threads/tscan.mjs activity          # кто ответил нам
//   node scripts/threads/tscan.mjs mine              # свои посты и ответы
//
// Плоский текст страницы ссылок не содержит, поэтому посты собираются из
// HTML-флейвора буфера обмена: каждый пост в ленте начинается с якоря
// /@user/post/<code>, а сразу за якорем идёт время и тело.
import { chromeGrab } from './tget.mjs'

const ME = 'vital_pavlenko'

const PERMALINK = /href="https:\/\/www\.threads\.com\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)"/g

const stripTags = (s) =>
  s.replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n').map((l) => l.trim()).filter(Boolean)

// «42 мин.» / «6 ч.» / «3 д.» / «2 нед.» / «14.02.2025»
function ageHours(token) {
  let m
  if ((m = token.match(/^(\d+)\s*(?:с|сек)\.?$/))) return Number(m[1]) / 3600
  if ((m = token.match(/^(\d+)\s*мин\.?$/))) return Number(m[1]) / 60
  if ((m = token.match(/^(\d+)\s*ч\.?$/))) return Number(m[1])
  if ((m = token.match(/^(\d+)\s*д\.?$/))) return Number(m[1]) * 24
  if ((m = token.match(/^(\d+)\s*нед\.?$/))) return Number(m[1]) * 168
  if ((m = token.match(/^(\d{2})\.(\d{2})\.(\d{4})$/))) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00Z`)
    return (Date.now() - d.getTime()) / 3600000
  }
  return null
}
const isTime = (t) => ageHours(t) !== null

export function parsePosts(html) {
  const hits = []
  let m
  PERMALINK.lastIndex = 0
  while ((m = PERMALINK.exec(html))) hits.push({ author: m[1], code: m[2], at: m.index })

  const seen = new Set()
  const posts = []
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    if (seen.has(h.code)) continue
    seen.add(h.code)
    const next = hits.slice(i + 1).find((x) => x.code !== h.code)
    let seg = html.slice(h.at, next ? next.at : html.length)
    // Сегмент обрывается посреди открывающего тега следующего поста — иначе его
    // атрибуты (простыня из классов) утекают в текст.
    const tail = seg.lastIndexOf('<')
    if (tail >= 0 && seg.indexOf('>', tail) === -1) seg = seg.slice(0, tail)
    const lines = stripTags(seg)
    // Хвост сегмента — имя следующего автора и подвал страницы у последнего поста.
    const junk = new Set(['© 2026', 'Условия Threads', 'Политика конфиденциальности',
                          'Политику в отношении файлов cookie'])
    while (lines.length && ((next && lines[lines.length - 1] === next.author) ||
                            junk.has(lines[lines.length - 1]))) lines.pop()

    let ti = lines.findIndex(isTime)
    if (ti < 0) ti = 0
    const time = lines[ti] || ''
    const body = lines.slice(ti + 1)
    let replyTo = null
    if (body[0] === 'В ответ' && /^@/.test(body[1] || '')) { body.shift(); replyTo = body.shift() }
    else if (/^В ответ @/.test(body[0] || '')) replyTo = body.shift().replace('В ответ ', '')
    // Хвостовые счётчики лайков/ответов приходят голыми числами — держим отдельно.
    const counts = []
    while (body.length && /^\d+$/.test(body[body.length - 1])) counts.unshift(Number(body.pop()))

    posts.push({
      author: h.author,
      code: h.code,
      url: `https://www.threads.com/@${h.author}/post/${h.code}`,
      time,
      age_h: ageHours(time),
      reply_to: replyTo,
      counts,
      text: body.join('\n'),
    })
  }
  return posts
}

function print(posts) {
  for (const p of posts) {
    console.log(`\n— @${p.author} · ${p.time}${p.reply_to ? ` · в ответ ${p.reply_to}` : ''}` +
                `${p.counts.length ? ` · ${p.counts.join('/')}` : ''}`)
    console.log(`  ${p.url}`)
    console.log(p.text.split('\n').map((l) => '  ' + l).join('\n'))
  }
  console.log(`\n[${posts.length} постов]`)
}

if (import.meta.url !== `file://${process.argv[1]}`) {
  // импортировали ради parsePosts — CLI не запускаем
} else main()

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
  if (!q) { console.error('usage: tscan.mjs search "<запрос>" [--top] [--max-age H] [--scroll N]'); process.exit(64) }
  const filter = args.includes('--top') ? '' : '&filter=recent'
  const url = `https://www.threads.com/search?q=${encodeURIComponent(q)}&serp_type=default${filter}`
  const { html } = chromeGrab(url, { scroll })
  const maxAge = Number(flag('max-age', 0))
  let posts = parsePosts(html).filter((p) => p.author !== ME)
  if (maxAge) posts = posts.filter((p) => p.age_h !== null && p.age_h <= maxAge)
  console.log(`# поиск: ${q} (${args.includes('--top') ? 'топ' : 'недавние'})`)
  print(posts)
} else if (cmd === 'tag') {
  // Тематическая лента: посты, у которых автор проставил тему («Сербский язык»).
  // Сортировка — по свежести, мусора меньше, чем в текстовом поиске.
  const q = args[1]
  const url = `https://www.threads.com/search?q=${encodeURIComponent(q)}&serp_type=tags`
  const { html } = chromeGrab(url, { scroll })
  const maxAge = Number(flag('max-age', 0))
  let posts = parsePosts(html).filter((p) => p.author !== ME)
  if (maxAge) posts = posts.filter((p) => p.age_h !== null && p.age_h <= maxAge)
  console.log(`# тема: ${q}`)
  print(posts)
} else if (cmd === 'post') {
  const url = args[1]
  if (!url) { console.error('usage: tscan.mjs post <url>'); process.exit(64) }
  const { text } = chromeGrab(url, { scroll })
  console.log(text.replace(/\n{3,}/g, '\n\n'))
} else if (cmd === 'activity') {
  const { html } = chromeGrab('https://www.threads.com/activity/replies', { scroll })
  print(parsePosts(html))
} else if (cmd === 'mine') {
  const which = args[1] === 'replies' ? '/replies' : ''
  const { html } = chromeGrab(`https://www.threads.com/@${ME}${which}`, { scroll })
  print(parsePosts(html))
} else {
  console.error(`usage:
  tscan.mjs search "<запрос>" [--top] [--max-age H] [--scroll N]
  tscan.mjs post <url> [--scroll N]
  tscan.mjs activity [--scroll N]
  tscan.mjs mine [replies]`)
  process.exit(64)
}
}
