import { describe, expect, it } from 'vitest'
import { CATALOG, defaultEdgeData } from './catalog'
import { erlangC, initialState, mmc, patternRps, simulateTick } from './engine'
import { recommend, reportMarkdown, runScenario } from './scenarios'
import { TEMPLATES } from './templates'
import type { Kind, Params, SimGraph } from './types'

const node = (id: string, kind: Kind, p: Partial<Params> = {}) => ({ id, kind, label: id, params: { ...CATALOG[kind].defaults, ...p } })
const edge = (s: string, t: string, sk: Kind, tk: Kind, d = {}) => ({ id: `${s}-${t}`, source: s, target: t, data: { ...defaultEdgeData(sk, tk), ...d } })

function simple(appInstances = 2, appRps = 500): SimGraph {
  return {
    nodes: [node('c', 'client'), node('lb', 'loadbalancer'), node('app', 'webserver', { instances: appInstances, maxRps: appRps, failureRate: 0 }), node('db', 'sqldb', { maxRps: 100000 })],
    edges: [edge('c', 'lb', 'client', 'loadbalancer'), edge('lb', 'app', 'loadbalancer', 'webserver'), edge('app', 'db', 'webserver', 'sqldb')],
  }
}

describe('queueing math', () => {
  it('Erlang C для c=1 равен ρ', () => {
    expect(erlangC(1, 0.5)).toBeCloseTo(0.5, 6)
  })
  it('Erlang C известное значение c=2, a=1 → 1/3', () => {
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 6)
  })
  it('M/M/1 среднее ожидание = ρ/(μ-λ)', () => {
    const p = mmc(50, 100, 1, 10000)
    expect(p.meanWaitMs).toBeCloseTo((0.5 / 50) * 1000, 4)
    expect(p.dropP).toBe(0)
  })
  it('перегрузка даёт потери = 1 - cap/λ', () => {
    const p = mmc(300, 100, 2, 1000)
    expect(p.rho).toBeCloseTo(1.5)
    expect(p.dropP).toBeCloseTo(1 / 3)
  })
})

describe('simulateTick', () => {
  it('трафик проходит через граф без потерь при низкой нагрузке', () => {
    const r = simulateTick(simple(), { rps: 400, readRatio: 0.8 }, initialState())
    expect(r.nodes.app.arrivals).toBeCloseTo(400)
    expect(r.nodes.db.arrivals).toBeCloseTo(400)
    expect(r.nodes.app.utilization).toBeCloseTo(0.4)
    expect(r.global.errorRate).toBe(0)
    expect(r.global.p50).toBeGreaterThan(0)
    expect(r.global.p99).toBeGreaterThanOrEqual(r.global.p95)
    expect(r.global.p95).toBeGreaterThanOrEqual(r.global.p50)
    expect(r.nodes.app.status).toBe('ok')
  })
  it('перегрузка подсвечивается и даёт ошибки', () => {
    const r = simulateTick(simple(1, 500), { rps: 1000, readRatio: 0.8 }, initialState())
    expect(r.nodes.app.status).toBe('hot')
    expect(r.nodes.app.dropped).toBeCloseTo(500)
    expect(r.global.errorRate).toBeGreaterThan(0.4)
    expect(r.global.errorRate).toBeLessThan(0.6)
    expect(r.global.bottleneck).toBe('app')
  })
  it('латентность растёт с загрузкой (очереди)', () => {
    const low = simulateTick(simple(1, 1000), { rps: 100, readRatio: 1 }, initialState(), {}, { samples: 4000 })
    const high = simulateTick(simple(1, 1000), { rps: 950, readRatio: 1 }, initialState(), {}, { samples: 4000 })
    expect(high.global.p95).toBeGreaterThan(low.global.p95)
    expect(high.nodes.app.latencyMs).toBeGreaterThan(low.nodes.app.latencyMs)
  })
  it('кэш снимает чтения с БД по hit ratio', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('app', 'webserver', { maxRps: 1e5 }), node('cache', 'cache', { hitRatio: 80 }), node('db', 'sqldb', { maxRps: 1e5 })],
      edges: [edge('c', 'app', 'client', 'webserver'), edge('app', 'cache', 'webserver', 'cache', { filter: 'read' }), edge('cache', 'db', 'cache', 'sqldb'), edge('app', 'db', 'webserver', 'sqldb', { filter: 'write' })],
    }
    const r = simulateTick(g, { rps: 1000, readRatio: 0.9 }, initialState())
    expect(r.nodes.cache.arrivals).toBeCloseTo(900)
    expect(r.nodes.db.reads).toBeCloseTo(180)
    expect(r.nodes.db.writes).toBeCloseTo(100)
  })
  it('read-реплики принимают чтения, primary — запись', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('db', 'sqldb', { maxRps: 1000, replicas: 2 })],
      edges: [edge('c', 'db', 'client', 'sqldb')],
    }
    const r = simulateTick(g, { rps: 1800, readRatio: 0.9 }, initialState())
    // 1620 чтений на 2 реплики (2000) и 180 записей на primary (1000)
    expect(r.nodes.db.utilization).toBeCloseTo(0.81, 2)
    expect(r.nodes.db.dropped).toBe(0)
  })
  it('балансировщик обходит упавший бэкенд', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('lb', 'loadbalancer'), node('a', 'webserver', { maxRps: 1000 }), node('b', 'webserver', { maxRps: 1000 })],
      edges: [edge('c', 'lb', 'client', 'loadbalancer'), edge('lb', 'a', 'loadbalancer', 'webserver'), edge('lb', 'b', 'loadbalancer', 'webserver')],
    }
    const ok = simulateTick(g, { rps: 1000, readRatio: 1 }, initialState())
    expect(ok.nodes.a.arrivals).toBeCloseTo(500)
    const failed = simulateTick(g, { rps: 1000, readRatio: 1 }, initialState(), { a: { down: true } })
    expect(failed.nodes.b.arrivals).toBeCloseTo(1000)
    expect(failed.nodes.a.status).toBe('down')
    expect(failed.global.errorRate).toBe(0)
  })
  it('без резерва падение узла = 100% ошибок', () => {
    const r = simulateTick(simple(), { rps: 100, readRatio: 1 }, initialState(), { app: { down: true } })
    expect(r.global.errorRate).toBe(1)
  })
  it('rate limiter отклоняет избыток, а не роняет систему', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('rl', 'ratelimiter', { limitRps: 500 }), node('app', 'webserver', { maxRps: 1000, instances: 1 })],
      edges: [edge('c', 'rl', 'client', 'ratelimiter'), edge('rl', 'app', 'ratelimiter', 'webserver')],
    }
    const r = simulateTick(g, { rps: 1000, readRatio: 1 }, initialState())
    expect(r.nodes.rl.rejected).toBeCloseTo(500)
    expect(r.nodes.app.arrivals).toBeCloseTo(500)
    expect(r.global.rejectedRate).toBeGreaterThan(0.4)
    expect(r.global.errorRate).toBe(0)
  })
  it('очередь копит backlog, если воркеры не успевают', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('q', 'queue'), node('w', 'worker', { instances: 1, maxRps: 100 })],
      edges: [edge('c', 'q', 'client', 'queue'), edge('q', 'w', 'queue', 'worker')],
    }
    let s = initialState()
    let r = simulateTick(g, { rps: 300, readRatio: 0 }, s)
    s = r.state
    r = simulateTick(g, { rps: 300, readRatio: 0 }, s)
    expect(r.nodes.q.backlog).toBeCloseTo(400)
    expect(r.nodes.w.arrivals).toBeCloseTo(100)
    expect(r.global.errorRate).toBe(0) // асинхронно — клиент получает ack
  })
  it('autoscaling добавляет инстансы под нагрузкой', () => {
    const g = simple(1, 500)
    g.nodes[2].params.autoscale = true
    g.nodes[2].params.maxInstances = 10
    let s = initialState()
    let last = simulateTick(g, { rps: 1500, readRatio: 1 }, s)
    for (let i = 0; i < 60; i++) {
      last = simulateTick(g, { rps: 1500, readRatio: 1 }, s)
      s = last.state
    }
    expect(last.nodes.app.instances).toBeGreaterThanOrEqual(4)
    expect(last.nodes.app.utilization).toBeLessThan(0.85)
  })
  it('стоимость считается по инстансам и запросам', () => {
    const g: SimGraph = { nodes: [node('c', 'client'), node('app', 'webserver', { instances: 2, costPerHour: 1 })], edges: [edge('c', 'app', 'client', 'webserver')] }
    const r = simulateTick(g, { rps: 10, readRatio: 1 }, initialState())
    expect(r.global.costMonth).toBeCloseTo(1460)
  })
  it('межрегиональный вызов добавляет латентность', () => {
    const g = simple()
    const same = simulateTick(g, { rps: 10, readRatio: 1 }, initialState(), {}, { samples: 3000 })
    g.nodes[3].params.region = 'us-east'
    const cross = simulateTick(g, { rps: 10, readRatio: 1 }, initialState(), {}, { samples: 3000 })
    expect(cross.global.p50 - same.global.p50).toBeGreaterThan(60)
  })
  it('циклы не вешают движок', () => {
    const g = simple()
    g.edges.push(edge('db', 'app', 'sqldb', 'webserver'))
    const r = simulateTick(g, { rps: 100, readRatio: 1 }, initialState())
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(Number.isFinite(r.global.p99)).toBe(true)
  })
})

describe('patterns', () => {
  it('spike даёт ×5', () => {
    expect(patternRps('spike', 100, 60, 120)).toBe(500)
    expect(patternRps('spike', 100, 10, 120)).toBe(100)
  })
  it('wave в диапазоне 25–100%', () => {
    const v = Array.from({ length: 120 }, (_, t) => patternRps('wave', 100, t, 120))
    expect(Math.min(...v)).toBeCloseTo(25, 0)
    expect(Math.max(...v)).toBeCloseTo(100, 0)
  })
})

describe('scenarios & templates', () => {
  it('все шаблоны симулируются без ошибок на своей нагрузке', () => {
    for (const t of TEMPLATES) {
      const r = simulateTick(t.graph, { rps: t.rps, readRatio: t.readRatio }, initialState())
      expect(r.global.errorRate, t.id).toBeLessThan(0.05)
      expect(r.global.p99, t.id).toBeGreaterThan(0)
    }
  })
  it('стресс-тест находит точку отказа', () => {
    const res = runScenario(simple(2, 500), 'stress', { baseRps: 500, readRatio: 0.8, slo: { p99Ms: 500, errorPct: 1 }, samples: 300 })
    expect(res.summary.breakingRps).toBeDefined()
    expect(res.summary.breakingRps!).toBeGreaterThan(700)
    expect(res.summary.breakingRps!).toBeLessThan(1200)
    expect(res.recommendations.some((r) => r.node === 'app' && r.severity === 'critical')).toBe(true)
  })
  it('failover без резерва проваливается и даёт рекомендацию', () => {
    const res = runScenario(simple(), 'failover', { baseRps: 300, readRatio: 0.8, slo: { p99Ms: 500, errorPct: 1 }, target: 'db', samples: 300 })
    expect(res.summary.passed).toBe(false)
    expect(res.summary.maxErrorPct).toBeGreaterThan(90)
    expect(res.summary.recoverySec).toBeDefined()
    expect(reportMarkdown(simple(), res, { p99Ms: 500, errorPct: 1 })).toContain('НЕ ПРОЙДЕН')
  })
  it('падение кэша перегружает БД в 3-tier', () => {
    const t = TEMPLATES.find((x) => x.id === 'three-tier')!
    const g = structuredClone(t.graph)
    const res = runScenario(g, 'cache', { baseRps: 3000, readRatio: 0.9, slo: { p99Ms: 500, errorPct: 1 }, samples: 300 })
    const db = res.peaks.find((p) => p.kind === 'sqldb')!
    expect(db.peakUtil).toBeGreaterThan(0.85)
  })
  it('primary БД с репликой восстанавливается после failover', () => {
    const t = TEMPLATES.find((x) => x.id === 'three-tier')!
    const res = runScenario(t.graph, 'db', { baseRps: 500, readRatio: 0.8, slo: { p99Ms: 800, errorPct: 1 }, samples: 300 })
    expect(res.summary.maxErrorPct).toBeGreaterThan(5)
    expect(res.summary.recoverySec).toBeDefined()
    expect(res.summary.recoverySec!).toBeLessThanOrEqual(40)
  })
  it('структурные рекомендации: SPOF и отсутствие кэша', () => {
    const recs = recommend(simple(1), null)
    expect(recs.some((r) => r.title.includes('SPOF'))).toBe(true)
    expect(recs.some((r) => r.title.includes('Нет кэша'))).toBe(true)
  })
})
