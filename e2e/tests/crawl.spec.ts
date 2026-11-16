import { test, expect, type Page } from '@playwright/test'

// Safe crawler: logs in as each role, follows links + tabs (never presses other buttons),
// and reports page errors, failed API calls, broken pages and mobile overflow.
const MAX = Math.min(Number(process.env.QA_CRAWL_MAX) || 25, 60)
const LOGIN_PATH = process.env.QA_LOGIN_PATH || '/login'
const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean)
const ROLES = [
  { role: 'advertiser', email: process.env.QA_ADVERTISER_EMAIL, pass: process.env.QA_ADVERTISER_PASSWORD, start: process.env.QA_ADVERTISER_LANDING || '/dashboard', forbidden: list(process.env.QA_ADVERTISER_FORBIDDEN) },
  { role: 'publisher', email: process.env.QA_PUBLISHER_EMAIL, pass: process.env.QA_PUBLISHER_PASSWORD, start: process.env.QA_PUBLISHER_LANDING || '/dashboard', forbidden: list(process.env.QA_PUBLISHER_FORBIDDEN) },
  { role: 'admin', email: process.env.QA_ADMIN_EMAIL, pass: process.env.QA_ADMIN_PASSWORD, start: process.env.QA_ADMIN_LANDING || '/admin', forbidden: [] as string[] }
]

// Never visited, never clicked: anything that could pay, charge, delete, log out or move money.
const DANGER = /(logout|log-out|signout|sign-out|delete|remove|revoke|withdraw|pay\b|checkout|topup|top-up|deposit|refund|billing\/add|impression|\/click|postback)/i
// Only ad-serving / payment endpoints are hard-blocked. Viewing pages like /payouts or /earnings is read-only and allowed.
const BILLING = /(\/api\/v1\/ads\/(match|impression|click)|\/api\/ads\/match|\/api\/payments)/i

async function login(page: Page, email: string, pass: string) {
  await page.goto(LOGIN_PATH, { waitUntil: 'networkidle' })
  await page.locator('input[type=email], input[name=email]').first().fill(email)
  await page.locator('input[type=password]').first().fill(pass)
  await page.locator('button[type=submit], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first().click()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('input[type=password]'), 'login failed').toHaveCount(0)
}

for (const r of ROLES) {
  test(`crawl as ${r.role}: every page, links, tabs, API calls`, async ({ page, baseURL }, info) => {
    test.skip(!r.email || !r.pass, `QA_${r.role.toUpperCase()}_EMAIL / PASSWORD not set`)
    test.setTimeout(240000)
    const origin = new URL(baseURL!).origin
    let loggedIn = false
    const blockedWrites: string[] = []
    // After login: browser may only READ. Any write or billing URL is aborted and listed.
    await page.route('**/*', route => {
      const req = route.request(), u = new URL(req.url())
      if (BILLING.test(u.pathname)) { blockedWrites.push(req.method() + ' ' + u.pathname); return route.abort() }
      if (loggedIn && !['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !/\/auth\/v1\/(token|user)/.test(u.pathname)) { blockedWrites.push(req.method() + ' ' + u.pathname); return route.abort() }
      return route.continue()
    })
    const jsErrors: Record<string, string[]> = {}, apiFails: Record<string, string[]> = {}
    let current = ''
    page.on('pageerror', e => (jsErrors[current] ||= []).push(e.message.slice(0, 160)))
    page.on('response', res => {
      const t = res.request().resourceType(), u = new URL(res.url())
      if (!['fetch', 'xhr'].includes(t) || res.request().method() !== 'GET') return
      if (res.status() >= 400 && (u.origin === origin || /supabase\.co$/.test(u.hostname))) (apiFails[current] ||= []).push(`${res.status()} ${u.pathname}`)
    })

    await login(page, r.email!, r.pass!)
    loggedIn = true

    const queue: string[] = [r.start], seen = new Set<string>(), rows: string[] = [], problems: string[] = []
    const norm = (href: string) => { try { const u = new URL(href, origin); return u.origin === origin ? u.pathname.replace(/\/$/, '') || '/' : null } catch { return null } }
    while (queue.length && seen.size < MAX) {
      const path = queue.shift()!
      if (seen.has(path) || DANGER.test(path) || path === LOGIN_PATH) continue
      seen.add(path); current = path
      const res = await page.goto(path, { waitUntil: 'networkidle' }).catch(e => { problems.push(`${path}: cannot load (${String(e.message).slice(0, 80)})`); return null })
      if (!res) continue
      const status = res.status()
      if (status >= 400) problems.push(`${path}: HTTP ${status}`)
      if (await page.locator('input[type=password]').count()) { problems.push(`${path}: sent back to login (session lost or no access)`); rows.push(`${path} -> login`); continue }
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      if (over > 2) problems.push(`${path}: sideways scroll ${over}px`)
      const body = (await page.locator('body').innerText()).slice(0, 4000)
      if (/(application error|unhandled runtime error|something went wrong|internal server error|undefined|\[object object\]|NaN)/i.test(body)) problems.push(`${path}: error/placeholder text on page`)
      // safe tabs only
      for (const tab of await page.locator('[role=tab]').all()) { const t = (await tab.innerText().catch(() => '')).trim(); if (t && !DANGER.test(t)) await tab.click({ timeout: 2000 }).catch(() => {}) }
      await page.waitForLoadState('networkidle').catch(() => {})
      for (const h of await page.locator('a[href]').evaluateAll(as => as.map(a => (a as HTMLAnchorElement).getAttribute('href') || ''))) {
        const n = norm(h)
        if (n && !seen.has(n) && !DANGER.test(n) && !/\.(png|jpg|svg|pdf|zip|ico)$/i.test(n)) queue.push(n)
      }
      const j = jsErrors[path] || [], a = apiFails[path] || []
      if (j.length) problems.push(`${path}: JS errors: ${[...new Set(j)].slice(0, 3).join(' | ')}`)
      if (a.length) problems.push(`${path}: failed API calls: ${[...new Set(a)].slice(0, 5).join(', ')}`)
      rows.push(`${path} -> HTTP ${status}${j.length ? ', JS errors' : ''}${a.length ? ', API fails' : ''}`)
    }

    for (const f of r.forbidden) {
      const res = await page.goto(f, { waitUntil: 'networkidle' }).catch(() => null)
      const gated = !res || res.status() >= 400 || (await page.locator('input[type=password]').count()) > 0 || !page.url().includes(f)
      rows.push(`FORBIDDEN ${f} -> ${gated ? 'blocked (good)' : 'OPEN (bad)'}`)
      if (!gated) problems.push(`${r.role} can open ${f} (should be blocked)`)
    }

    const summary = [`Role: ${r.role}`, `Pages visited: ${seen.size} (limit ${MAX})`, `Write/billing requests blocked by QA: ${blockedWrites.length}${blockedWrites.length ? ' e.g. ' + [...new Set(blockedWrites)].slice(0, 5).join(', ') : ''}`, '', ...rows, '', problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'No problems found.'].join('\n')
    console.log('\n' + summary)
    await info.attach(`crawl-${r.role}.txt`, { body: summary, contentType: 'text/plain' })
    expect(problems, `${problems.length} problem(s) found`).toEqual([])
  })
}
