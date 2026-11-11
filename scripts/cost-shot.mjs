// Скриншот AI-поддержки с разбивкой стоимости: URL=... node scripts/cost-shot.mjs
import { chromium } from 'playwright'
const url = process.env.URL ?? 'https://javedius.github.io/arch-sim/'
const b = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
const errors = []
try {
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } })
  p.on('pageerror', (e) => errors.push(String(e)))
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await p.goto(url)
  await p.waitForSelector('.arch-node')
  const info = {}
  for (const tpl of ['RAG', 'Мультиагентная', 'AI-поддержка']) {
    await p.click('text=Шаблоны')
    await p.click(`.dd-item:has-text("${tpl}")`)
    await p.waitForTimeout(700)
    info[tpl] = await p.locator('.kpi.cost b').innerText()
  }
  await p.click('button:has-text("Старт")')
  await p.waitForTimeout(3500)
  await p.screenshot({ path: process.env.OUT ?? '/workspace/arch-sim-cost.png' })
  await p.click('button:has-text("Пауза")')
  await p.click('button:has-text("Тест-планы")')
  await p.click('.sc-config button:has-text("Прогнать все")')
  await p.waitForSelector('.tbl', { timeout: 90000 })
  const results = await p.locator('.tbl tbody tr').allInnerTexts()
  console.log(JSON.stringify({ costs: info, results, errors }, null, 1))
  if (errors.length) process.exitCode = 1
} finally {
  await b.close()
}
