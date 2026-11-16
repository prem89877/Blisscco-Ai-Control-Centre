import { test, expect, type Page } from '@playwright/test'

// ---- config (all from GitHub Actions env / secrets) ----
const PAGES = (process.env.QA_PATHS || '/').split(',').map(s => s.trim()).filter(Boolean)
const PROTECTED = (process.env.QA_PROTECTED_PATHS || '').split(',').map(s => s.trim()).filter(Boolean)
const ACCOUNTS = [
  { role: 'advertiser', email: process.env.QA_ADVERTISER_EMAIL, pass: process.env.QA_ADVERTISER_PASSWORD, landing: process.env.QA_ADVERTISER_LANDING },
  { role: 'publisher', email: process.env.QA_PUBLISHER_EMAIL, pass: process.env.QA_PUBLISHER_PASSWORD, landing: process.env.QA_PUBLISHER_LANDING },
  { role: 'admin', email: process.env.QA_ADMIN_EMAIL, pass: process.env.QA_ADMIN_PASSWORD, landing: process.env.QA_ADMIN_LANDING }
]
const LOGIN_PATH = process.env.QA_LOGIN_PATH || '/login'

// BILLING SAFETY: the browser can never reach anything that could create an impression, click, charge, earning or payout.
const BILLING = /(impression|\/click|track|serve|postback|conversion|payout|payment|withdraw|billing|invoice|ledger|earning|charge|checkout|topup|deposit|refund)/i
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => (BILLING.test(new URL(route.request().url()).pathname) ? route.abort() : route.continue()))
})

const noOverflow = async (page: Page) => {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(o, 'page scrolls sideways by ' + o + 'px').toBeLessThanOrEqual(2)
}

for (const path of PAGES) {
  test(`page ${path}: loads, no JS errors, responsive`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    const res = await page.goto(path, { waitUntil: 'networkidle' })
    expect(res && res.status(), 'HTTP status').toBeLessThan(400)
    await expect(page).toHaveTitle(/.+/)
    expect(errors, 'JavaScript errors').toEqual([])
    await noOverflow(page)
    if (info.project.name === 'mobile') {
      const small = await page.evaluate(() => [...document.querySelectorAll('button,a,input')].filter(e => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 24 || r.width < 24) }).length)
      expect(small, 'tap targets smaller than 24px').toBeLessThan(6)
    }
  })
}

test('login page shows a password field', async ({ page }) => {
  await page.goto(LOGIN_PATH)
  await expect(page.locator('input[type=password]').first()).toBeVisible()
})

test('wrong password is rejected (no session)', async ({ page }) => {
  await page.goto(LOGIN_PATH)
  await page.locator('input[type=email], input[name=email]').first().fill('qa-nobody@example.invalid')
  await page.locator('input[type=password]').first().fill('definitely-wrong-password')
  await page.locator('button[type=submit], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first().click()
  await page.waitForTimeout(2500)
  await expect(page.locator('input[type=password]').first()).toBeVisible()
})

for (const p of PROTECTED) {
  test(`anonymous visitor cannot use ${p}`, async ({ page }) => {
    await page.goto(p, { waitUntil: 'networkidle' })
    const sensitive = await page.locator('text=/balance|payout|earnings|api key/i').count()
    const gate = await page.locator('input[type=password]').count()
    expect(sensitive === 0 || gate > 0, 'sensitive content visible without login').toBeTruthy()
  })
}

for (const a of ACCOUNTS) {
  test(`${a.role} can log in and see the dashboard`, async ({ page }) => {
    test.skip(!a.email || !a.pass, `QA_${a.role.toUpperCase()}_EMAIL/PASSWORD not set`)
    await page.goto(LOGIN_PATH)
    await page.locator('input[type=email], input[name=email]').first().fill(a.email!)
    await page.locator('input[type=password]').first().fill(a.pass!)
    await page.locator('button[type=submit], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first().click()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('input[type=password]')).toHaveCount(0)
    if (a.landing) { await page.goto(a.landing, { waitUntil: 'networkidle' }); await expect(page.locator('input[type=password]')).toHaveCount(0) }
    await noOverflow(page)
  })
}

test('role separation: advertiser/publisher accounts cannot open admin', async ({ page }) => {
  const admin = (process.env.QA_ADMIN_LANDING || '').trim()
  const acct = ACCOUNTS.find(a => a.role !== 'admin' && a.email && a.pass)
  test.skip(!admin || !acct, 'needs QA_ADMIN_LANDING and a non-admin test account')
  await page.goto(LOGIN_PATH)
  await page.locator('input[type=email], input[name=email]').first().fill(acct!.email!)
  await page.locator('input[type=password]').first().fill(acct!.pass!)
  await page.locator('button[type=submit], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login")').first().click()
  await page.waitForLoadState('networkidle')
  await page.goto(admin, { waitUntil: 'networkidle' })
  const adminWords = await page.locator('text=/all users|all publishers|all advertisers|system settings|admin panel/i').count()
  expect(adminWords, 'non-admin sees admin content').toBe(0)
})
