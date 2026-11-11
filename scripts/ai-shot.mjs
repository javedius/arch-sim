// Скриншот AI-шаблона и проверка консоли: URL=... node scripts/ai-shot.mjs
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
  const aiItems = await p.locator('.pal-group:has(.pal-cat:text-is("AI")) .pal-item').count()
  for (const tpl of ['RAG', 'AI-поддержка', 'Мультиагентная']) {
    await p.click('text=Шаблоны')
    await p.click(`.dd-item:has-text("${tpl}")`)
    await p.waitForTimeout(400)
  }
  await p.click('button:has-text("Старт")')
  await p.waitForTimeout(4000)
  await p.click('.arch-node:has-text("Research Agent")')
  await p.waitForTimeout(300)
  await p.click('.react-flow__pane', { position: { x: 30, y: 30 } })
  await p.click('.arch-node:has-text("Llama-3.1-8B")')
  await p.waitForTimeout(500)
  await p.screenshot({ path: process.env.OUT ?? '/workspace/arch-sim-ai.png' })
  await p.click('button:has-text("Пауза")')
  await p.click('button:has-text("Тест-планы")')
  await p.click('.sc-config button:has-text("Прогнать все")')
  await p.waitForSelector('.tbl', { timeout: 90000 })
  const rows = await p.locator('.tbl tbody tr').count()
  console.log(JSON.stringify({ aiPaletteItems: aiItems, suiteRows: rows, errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await b.close()
}
