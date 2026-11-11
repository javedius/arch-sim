// Headless-проверка: рендер, живая симуляция, тест-план, без ошибок в консоли
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'

const port = 4179
const server = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 2500))
const out = process.env.SHOT_DIR ?? '/workspace'
const errors = []
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${port}/`)
  await page.waitForSelector('.arch-node')
  // шаблон Twitter
  await page.click('text=Шаблоны')
  await page.click('.dd-item:has-text("RAG")')
  await page.waitForTimeout(500)
  // добавить узел кликом по палитре
  await page.click('.pal-item[data-kind="llm"]')
  await page.click('.react-flow__pane', { position: { x: 50, y: 50 } })
  await page.click('button:has-text("Старт")')
  await page.waitForTimeout(3500)
  const nodes = await page.locator('.arch-node').count()
  const hist = await page.locator('.recharts-line').count()
  await page.screenshot({ path: `${out}/arch-sim-screenshot.png` })
  // перегрузка
  await page.fill('.ctl-group.load input.num', '120')
  await page.waitForTimeout(2500)
  const hot = await page.locator('.arch-node.status-hot').count()
  await page.screenshot({ path: `${out}/arch-sim-overload.png` })
  await page.click('button:has-text("Пауза")')
  await page.fill('.ctl-group.load input.num', '50')
  // тест-план
  await page.click('button:has-text("Тест-планы")')
  await page.click('.sc-item:has-text("Стресс")')
  await page.click('.sc-config button:has-text("Запустить")')
  await page.waitForSelector('.result h3', { timeout: 30000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/arch-sim-testplan.png` })
  await page.click('.sc-config button:has-text("Прогнать все")')
  await page.waitForSelector('.tbl', { timeout: 60000 })
  const rows = await page.locator('.tbl tbody tr').count()
  await page.screenshot({ path: `${out}/arch-sim-suite.png` })
  console.log(JSON.stringify({ nodes, chartLines: hist, hotNodes: hot, suiteRows: rows, errors }, null, 1))
  if (errors.length) process.exitCode = 1
} finally {
  await browser.close()
  server.kill('SIGKILL')
}
