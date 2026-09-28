#!/usr/bin/env node
// Разведка по Reddit глазами залогиненного Chrome (см. rget.mjs).
// Печатает компактный JSON, чтобы не тащить в контекст мегабайты сырых ответов.
//
//   node scripts/reddit/rscan.mjs me
//   node scripts/reddit/rscan.mjs scan languagelearning,EnglishLearning [--max-age 18] [--max-comments 25]
//   node scripts/reddit/rscan.mjs search "how to memorize vocabulary" [--sub languagelearning] [--t week]
//   node scripts/reddit/rscan.mjs rules languagelearning
//   node scripts/reddit/rscan.mjs thread /r/xxx/comments/abc/slug/
//   node scripts/reddit/rscan.mjs inbox [--unread]
//   node scripts/reddit/rscan.mjs mine [username]
import { chromeJson } from './rget.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))
const flag = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? def : argv[i + 1]
}
const out = (v) => console.log(JSON.stringify(v, null, 2))
const ageH = (utc) => +((Date.now() / 1000 - utc) / 3600).toFixed(1)

if (cmd === 'me') {
  // /api/v1/me.json — OAuth-эндпоинт, по кукам он отдаёт один только features.
  // Кукам отвечает старый /api/me.json, где всё лежит в .data.
  const m = chromeJson('https://www.reddit.com/api/me.json').data
  if (!m?.name) throw new Error('не залогинен в Chrome на reddit.com')
  out({
    username: m.name,
    comment_karma: m.comment_karma,
    link_karma: m.link_karma,
    total_karma: m.total_karma,
    created: new Date(m.created_utc * 1000).toISOString(),
    age_days: Math.round((Date.now() / 1000 - m.created_utc) / 86400),
    suspended: m.is_suspended,
    verified_email: m.has_verified_email,
  })
} else if (cmd === 'scan') {
  const subs = (positional[0] || '').split(',').filter(Boolean)
  const maxAge = +flag('max-age', 24)
  const maxComments = +flag('max-comments', 30)
  const limit = flag('limit', '25')
  const rows = []
  for (const s of subs) {
    let j
    try {
      j = chromeJson(`https://www.reddit.com/r/${s}/new/.json?limit=${limit}`)
    } catch (e) {
      rows.push({ sub: s, error: String(e.message).slice(0, 200) })
      continue
    }
    for (const { data: p } of j.data?.children ?? []) {
      const h = ageH(p.created_utc)
      if (h > maxAge || p.locked || p.stickied || p.num_comments > maxComments) continue
      rows.push({
        sub: s,
        age_h: h,
        n: p.num_comments,
        score: p.score,
        flair: p.link_flair_text || null,
        title: p.title,
        body: (p.selftext || '').replace(/\s+/g, ' ').slice(0, 700),
        url: 'https://www.reddit.com' + p.permalink,
      })
    }
  }
  rows.sort((a, b) => (a.age_h ?? 99) - (b.age_h ?? 99))
  out(rows)
} else if (cmd === 'search') {
  const q = positional[0]
  const sub = flag('sub', null)
  const t = flag('t', 'week')
  const base = sub ? `https://www.reddit.com/r/${sub}/search/.json?restrict_sr=1&` : 'https://www.reddit.com/search/.json?'
  const j = chromeJson(`${base}q=${encodeURIComponent(q)}&sort=new&t=${t}&limit=25`)
  out((j.data?.children ?? []).map(({ data: p }) => ({
    sub: p.subreddit, age_h: ageH(p.created_utc), n: p.num_comments, score: p.score,
    title: p.title, body: (p.selftext || '').replace(/\s+/g, ' ').slice(0, 400),
    url: 'https://www.reddit.com' + p.permalink,
  })))
} else if (cmd === 'rules') {
  const sub = positional[0]
  const j = chromeJson(`https://www.reddit.com/r/${sub}/about/rules.json`)
  out((j.rules ?? []).map((r) => ({
    name: r.short_name,
    applies: r.kind,
    text: (r.description || '').replace(/\s+/g, ' ').slice(0, 600),
  })))
} else if (cmd === 'thread') {
  const p = positional[0].replace(/^https?:\/\/[^/]+/, '')
  const j = chromeJson(`https://www.reddit.com${p.replace(/\/$/, '')}/.json?limit=40&sort=top`)
  const post = j[0].data.children[0].data
  const walk = (children, depth = 0) => children.flatMap(({ kind, data: c }) =>
    kind !== 't1' ? [] : [
      { depth, by: c.author, score: c.score, body: (c.body || '').replace(/\s+/g, ' ').slice(0, 500) },
      ...walk(c.replies?.data?.children ?? [], depth + 1),
    ])
  out({
    title: post.title,
    sub: post.subreddit,
    age_h: ageH(post.created_utc),
    body: (post.selftext || '').replace(/\s+/g, ' ').slice(0, 2000),
    comments: walk(j[1].data.children).slice(0, 30),
  })
} else if (cmd === 'inbox') {
  // Ответы на наши комментарии. --unread берёт только непрочитанное.
  const box = argv.includes('--unread') ? 'unread' : 'inbox'
  const j = chromeJson(`https://www.reddit.com/message/${box}/.json?limit=50`)
  out((j.data?.children ?? []).map(({ data: m }) => ({
    id: m.id,
    kind: m.was_comment ? 'reply' : 'message',
    by: m.author,
    sub: m.subreddit,
    new: m.new,
    age_h: ageH(m.created_utc),
    on: m.link_title,
    body: (m.body || '').replace(/\s+/g, ' ').slice(0, 700),
    link: m.context ? 'https://www.reddit.com' + m.context : null,
  })))
} else if (cmd === 'mine') {
  const user = positional[0] || chromeJson('https://www.reddit.com/api/me.json').data?.name
  // /user/<me>/comments/.json на этом аккаунте стабильно отдаёт пустой список —
  // берём overview и отбираем комментарии (kind t1) сами.
  const j = chromeJson(`https://www.reddit.com/user/${user}/overview/.json?limit=100`)
  out((j.data?.children ?? []).filter((c) => c.kind === 't1').map(({ data: c }) => ({
    id: c.id,
    sub: c.subreddit,
    score: c.score,
    age_h: ageH(c.created_utc),
    removed: c.banned_by != null || c.body === '[removed]',
    body: (c.body || '').replace(/\s+/g, ' ').slice(0, 200),
    link: 'https://www.reddit.com' + c.permalink,
  })))
} else {
  console.error('cmd: me | scan | search | rules | thread | inbox | mine')
  process.exit(64)
}
