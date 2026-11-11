import { describe, expect, it } from 'vitest'
import { aiRecommendations, batchSlowdown, deriveNode, tokenInfo } from './ai'
import { CATALOG, defaultEdgeData } from './catalog'
import { initialState, simulateTick } from './engine'
import { recommend, runScenario } from './scenarios'
import { TEMPLATES } from './templates'
import type { Kind, Params, SimGraph } from './types'

const P = (kind: Kind, p: Partial<Params> = {}): Params => ({ ...CATALOG[kind].defaults, ...p })
const node = (id: string, kind: Kind, p: Partial<Params> = {}) => ({ id, kind, label: id, params: P(kind, p) })
const edge = (s: string, t: string, sk: Kind, tk: Kind, d = {}) => ({ id: `${s}-${t}`, source: s, target: t, data: { ...defaultEdgeData(sk, tk), ...d } })

describe('токенная математика', () => {
  it('LLM API: латентность = TTFT + out/скорость', () => {
    const i = tokenInfo('llmapi', P('llmapi', { ttftMs: 500, outTokens: 200, tokensPerSec: 100 }))!
    expect(i.latencyMs).toBeCloseTo(2500)
  })
  it('LLM API: цена = in×$in/1M + out×$out/1M', () => {
    const i = tokenInfo('llmapi', P('llmapi', { inTokens: 1000, outTokens: 500, costPer1MIn: 3, costPer1MOut: 15 }))!
    expect(i.costPerReq).toBeCloseTo(0.003 + 0.0075, 8)
  })
  it('LLM API: ёмкость = TPM / токенов на запрос / 60', () => {
    const i = tokenInfo('llmapi', P('llmapi', { inTokens: 900, outTokens: 100, tpmLimit: 600_000 }))!
    expect(i.maxRps).toBeCloseTo(10)
  })
  it('GPU: ёмкость реплики = batch / время генерации; batch увеличивает пропускную', () => {
    const b1 = tokenInfo('gpullm', P('gpullm', { batchSize: 1, tokensPerSec: 50, ttftMs: 100, inTokens: 0, outTokens: 100 }))!
    expect(b1.latencyMs).toBeCloseTo(2100)
    expect(b1.maxRps).toBeCloseTo(1 / 2.1, 4)
    const b32 = tokenInfo('gpullm', P('gpullm', { batchSize: 32, tokensPerSec: 50, ttftMs: 100, inTokens: 0, outTokens: 100 }))!
    expect(b32.perStreamTps).toBeCloseTo(50 / batchSlowdown(32))
    expect(b32.latencyMs).toBeGreaterThan(b1.latencyMs)
    expect(b32.maxRps).toBeGreaterThan(b1.maxRps * 10)
  })
  it('GPU: входные токены добавляют prefill', () => {
    const a = tokenInfo('gpullm', P('gpullm', { inTokens: 0 }))!
    const b = tokenInfo('gpullm', P('gpullm', { inTokens: 5000 }))!
    expect(b.latencyMs).toBeGreaterThan(a.latencyMs)
  })
  it('Embeddings: ёмкость = токенов/с / входных токенов', () => {
    const i = tokenInfo('embedding', P('embedding', { throughputTps: 10000, inTokens: 500 }))!
    expect(i.maxRps).toBeCloseTo(20)
  })
  it('Vector DB: больше recall и индекс — медленнее', () => {
    const lo = tokenInfo('vectordb', P('vectordb', { recall: 90, indexM: 1 }))!
    const hi = tokenInfo('vectordb', P('vectordb', { recall: 99, indexM: 100 }))!
    expect(hi.latencyMs).toBeGreaterThan(lo.latencyMs)
    expect(hi.maxRps).toBeLessThan(lo.maxRps)
  })
  it('deriveNode подставляет цену за 1000 запросов из токенов', () => {
    const n = deriveNode(node('l', 'llmapi', { inTokens: 1000, outTokens: 0, costPer1MIn: 2 }))
    expect(n.params.costPer1kReq).toBeCloseTo(2)
  })
})

describe('AI в симуляции', () => {
  const chain = (extra: Partial<Params> = {}): SimGraph => ({
    nodes: [node('c', 'client'), node('llm', 'llmapi', { inTokens: 900, outTokens: 100, tpmLimit: 600_000, failureRate: 0, costPer1MIn: 1, costPer1MOut: 0, ...extra })],
    edges: [edge('c', 'llm', 'client', 'llmapi')],
  })
  it('сверх TPM — 429 от провайдера считаются ошибками', () => {
    const r = simulateTick(chain(), { rps: 20, readRatio: 1 }, initialState(), {}, { samples: 4000 })
    expect(r.nodes.llm.rejected).toBeCloseTo(10)
    expect(r.global.errorRate).toBeGreaterThan(0.4)
    expect(r.global.errorRate).toBeLessThan(0.6)
  })
  it('месячная стоимость LLM API считается по токенам', () => {
    const r = simulateTick(chain(), { rps: 1, readRatio: 1 }, initialState())
    // 900 токенов × $1/1M × 1 rps × 2 628 000 с
    expect(r.nodes.llm.costMonth).toBeCloseTo(0.0009 * 2_628_000, 0)
  })
  it('сквозная латентность определяется токенами', () => {
    const r = simulateTick(chain({ ttftMs: 400, outTokens: 300, tokensPerSec: 100 }), { rps: 1, readRatio: 1 }, initialState(), {}, { samples: 3000 })
    expect(r.global.p50).toBeGreaterThan(2400)
    expect(r.global.p50).toBeLessThan(4500)
  })
  it('шаги агента умножают вызовы зависимостей и латентность', () => {
    const g = (steps: number): SimGraph => ({
      nodes: [node('c', 'client'), node('a', 'agent', { steps }), node('t', 'mcp', { latencyMs: 100, maxRps: 1e5 })],
      edges: [edge('c', 'a', 'client', 'agent'), edge('a', 't', 'agent', 'mcp')],
    })
    const r1 = simulateTick(g(1), { rps: 10, readRatio: 1 }, initialState(), {}, { samples: 2000 })
    const r5 = simulateTick(g(5), { rps: 10, readRatio: 1 }, initialState(), {}, { samples: 2000 })
    expect(r5.nodes.t.arrivals).toBeCloseTo(50)
    expect(r1.nodes.t.arrivals).toBeCloseTo(10)
    expect(r5.global.p50).toBeGreaterThan(r1.global.p50 * 3)
  })
  it('семантический кэш снимает вызовы LLM по hit ratio', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('s', 'semcache', { hitRatio: 40 }), node('l', 'llmapi', { tpmLimit: 1e9 })],
      edges: [edge('c', 's', 'client', 'semcache'), edge('s', 'l', 'semcache', 'llmapi')],
    }
    const r = simulateTick(g, { rps: 100, readRatio: 1 }, initialState())
    expect(r.nodes.l.arrivals).toBeCloseTo(60)
  })
  it('guardrails отклоняют долю запросов до LLM', () => {
    const g: SimGraph = {
      nodes: [node('c', 'client'), node('g', 'guardrails', { blockRate: 10 }), node('l', 'llmapi', { tpmLimit: 1e9 })],
      edges: [edge('c', 'g', 'client', 'guardrails'), edge('g', 'l', 'guardrails', 'llmapi')],
    }
    const r = simulateTick(g, { rps: 100, readRatio: 1 }, initialState())
    expect(r.nodes.l.arrivals).toBeCloseTo(90)
  })
  it('GPU LLM перегружается и даёт рекомендацию', () => {
    const g: SimGraph = { nodes: [node('c', 'client'), node('gpu', 'gpullm', { instances: 1, batchSize: 4 })], edges: [edge('c', 'gpu', 'client', 'gpullm')] }
    const res = runScenario(g, 'load', { baseRps: 20, readRatio: 1, slo: { p99Ms: 10000, errorPct: 1 }, samples: 200 })
    expect(res.summary.passed).toBe(false)
    expect(res.recommendations.some((r) => r.node === 'gpu' && r.severity === 'critical')).toBe(true)
    expect(res.recommendations.some((r) => r.title.includes('batch'))).toBe(true)
  })
})

describe('AI-рекомендации', () => {
  it('советует семантический кэш, guardrails и model routing', () => {
    const g: SimGraph = { nodes: [node('c', 'client'), node('l', 'llmapi', { inTokens: 4000, outTokens: 500 })], edges: [edge('c', 'l', 'client', 'llmapi')] }
    const titles = aiRecommendations(g).map((r) => r.title).join('|')
    expect(titles).toContain('семантического кэша')
    expect(titles).toContain('guardrails')
    expect(titles).toContain('дорогая модель')
    expect(titles).toContain('много токенов')
  })
  it('предупреждает о TPM лимите под нагрузкой', () => {
    const g: SimGraph = { nodes: [node('c', 'client'), node('l', 'llmapi', { inTokens: 900, outTokens: 100, tpmLimit: 600_000 })], edges: [edge('c', 'l', 'client', 'llmapi')] }
    const res = runScenario(g, 'load', { baseRps: 9, readRatio: 1, slo: { p99Ms: 60000, errorPct: 1 }, samples: 200 })
    expect(res.recommendations.some((r) => r.title.includes('TPM'))).toBe(true)
  })
  it('предупреждает о большом числе шагов агента', () => {
    const g: SimGraph = { nodes: [node('c', 'client'), node('a', 'agent', { steps: 8 }), node('l', 'llmapi')], edges: [edge('c', 'a', 'client', 'agent'), edge('a', 'l', 'agent', 'llmapi')] }
    expect(recommend(g, null).some((r) => r.title.includes('шагов'))).toBe(true)
  })
  it('AI-шаблоны выдерживают свою нагрузку и укладываются в SLO', () => {
    for (const id of ['rag', 'multi-agent', 'ai-support']) {
      const t = TEMPLATES.find((x) => x.id === id)!
      const r = simulateTick(t.graph, { rps: t.rps, readRatio: t.readRatio }, initialState(), {}, { samples: 3000 })
      expect(r.global.errorRate, id).toBeLessThan((t.slo?.errorPct ?? 1) / 100 + 0.01)
      expect(r.global.p99, id).toBeLessThan(t.slo!.p99Ms)
      expect(r.global.costMonth, id).toBeGreaterThan(0)
    }
  })
})
