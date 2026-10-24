'use strict'

// CnGal 公开接口：首页四组数据，全部匿名可读、境内直连。
const BASE = 'https://api.cngal.org'
const SITE = 'https://www.cngal.org/'

const ENDPOINTS = {
  news: '/api/home/GetHomeNewsView',
  upcoming: '/api/home/ListUpcomingGames',
  published: '/api/home/ListPublishedGames',
  discount: '/api/home/ListDiscountGames',
}

async function getJson(path, timeoutMs = 15000) {
  const response = await fetch(BASE + path, {
    headers: { 'User-Agent': 'QixinBot/galgame', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function stamp(text) {
  const raw = String(text || '').trim()
  const date = raw.slice(0, 10).replace(/\//g, '-')
  return { date, clock: raw.slice(11, 16) }
}

function absUrl(link) {
  const value = String(link || '').trim()
  if (!value) return SITE
  if (/^https?:\/\//i.test(value)) return value
  return SITE + value.replace(/^\/+/, '')
}

function normalizeNews(rows) {
  return (Array.isArray(rows) ? rows : []).map((item, index) => {
    const { date, clock } = stamp(item.time)
    return {
      id: `n${index}`,
      group: String(item.title || '').trim(),
      text: String(item.text || '').trim(),
      date,
      clock,
      link: absUrl(item.link),
      image: item.image || '',
    }
  })
}

function normalizeGames(rows, withDate) {
  return (Array.isArray(rows) ? rows : []).map((item, index) => ({
    id: `g${index}`,
    name: String(item.name || '').trim(),
    brief: String(item.briefIntroduction || '').trim(),
    tags: (item.tags || []).filter(Boolean),
    date: withDate ? String(item.publishTime || '').trim() : '',
    url: absUrl(item.url),
    image: item.image || '',
  }))
}

function normalizeDiscount(rows) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(rows) ? rows : []) {
    const name = String(item.name || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      id: `d${out.length}`,
      name,
      brief: String(item.briefIntroduction || '').trim(),
      price: typeof item.price === 'number' ? item.price : null,
      cut: typeof item.cut === 'number' ? item.cut : null,
      url: absUrl(item.url),
      image: item.image || '',
    })
  }
  return out
}

/**
 * 拉取并归一化四组数据。任何一组失败都不影响其他组。
 */
async function fetchAll(logger) {
  const keys = Object.keys(ENDPOINTS)
  const results = await Promise.allSettled(keys.map((key) => getJson(ENDPOINTS[key])))
  const data = { news: [], upcoming: [], published: [], discount: [], errors: [] }

  keys.forEach((key, index) => {
    const result = results[index]
    if (result.status === 'rejected') {
      data.errors.push(`${key}: ${result.reason?.message || result.reason}`)
      logger?.warn?.(`galgame: fetch ${key} failed: ${result.reason?.message || result.reason}`)
      return
    }
    const rows = result.value
    if (key === 'news') data.news = normalizeNews(rows)
    else if (key === 'discount') data.discount = normalizeDiscount(rows)
    else data[key] = normalizeGames(rows, key === 'upcoming')
  })

  return data
}

/** 只保留最近 days 天内的动态。 */
function recentNews(news, days = 7) {
  const limit = Date.now() - days * 24 * 3600 * 1000
  return news.filter((item) => {
    const time = Date.parse(item.date + 'T00:00:00+08:00')
    return Number.isFinite(time) ? time >= limit : true
  })
}

module.exports = { fetchAll, recentNews, normalizeNews, normalizeGames, normalizeDiscount }


