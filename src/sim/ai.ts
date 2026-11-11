import type { Kind, Params, SimGraph, SimNode } from './types'

/**
 * Пресеты GPU для модели класса 8B (одна GPU на реплику, vLLM).
 * tokensPerSec — скорость одного потока при batch=1. Цены — on-demand, ноябрь 2026 (RunPod/Lambda).
 * H100 + Llama-3.1-8B: ~158 ток/с при concurrency 1, ~2900 ток/с суммарно при 32, ~4000 при 64 (vLLM).
 */
export const GPU_PRESETS: Record<string, { tokensPerSec: number; costPerHour: number; ttftMs: number }> = {
  L4: { tokensPerSec: 35, costPerHour: 0.59, ttftMs: 250 },
  A10G: { tokensPerSec: 45, costPerHour: 1.29, ttftMs: 200 },
  'A100-80G': { tokensPerSec: 110, costPerHour: 1.79, ttftMs: 120 },
  H100: { tokensPerSec: 158, costPerHour: 3.99, ttftMs: 100 },
  H200: { tokensPerSec: 190, costPerHour: 5.29, ttftMs: 90 },
}

/** Для больших моделей (70B+) реплика — 4 GPU с tensor parallel: медленнее поток, дороже час */
export function modelScale(model?: string): { speed: number; gpus: number } {
  const m = (model ?? '').toLowerCase()
  if (/(405|400)b/.test(m)) return { speed: 0.12, gpus: 8 }
  if (/(70|72)b/.test(m)) return { speed: 0.35, gpus: 4 }
  if (/(27|32|34)b/.test(m)) return { speed: 0.55, gpus: 2 }
  return { speed: 1, gpus: 1 }
}

export const TOKEN_KINDS: Kind[] = ['llmapi', 'gpullm', 'embedding', 'vectordb']
export const LLM_KINDS: Kind[] = ['llmapi', 'gpullm', 'llm']

export interface TokenInfo {
  latencyMs: number // время ответа одного запроса без очередей
  maxRps: number // на инстанс (для llmapi — на весь аккаунт по TPM)
  costPerReq: number // $ за запрос по токенам
  perStreamTps?: number
  tokensPerReq?: number
}

/** $ за запрос к LLM API с учётом prompt caching */
export function llmApiCostPerReq(p: Params): number {
  const tin = Math.max(0, p.inTokens ?? 0)
  const tout = Math.max(0, p.outTokens ?? 0)
  const cached = tin * Math.min(1, Math.max(0, (p.cachedInputPct ?? 0) / 100))
  const disc = Math.min(1, Math.max(0, (p.cacheDiscount ?? 90) / 100))
  const pin = p.costPer1MIn ?? 0
  return ((tin - cached) * pin + cached * pin * (1 - disc) + tout * (p.costPer1MOut ?? 0)) / 1e6
}

/** Замедление потока при росте batch: память/вычисления делятся между потоками */
export function batchSlowdown(batch: number): number {
  // калибровка по vLLM/H100: поток 158 → ~91 ток/с при batch 32, ~63 при 64
  return 1 + 0.024 * Math.max(0, batch - 1)
}

export function tokenInfo(kind: Kind, p: Params): TokenInfo | null {
  const tin = Math.max(0, p.inTokens ?? 0)
  const tout = Math.max(0, p.outTokens ?? 0)
  switch (kind) {
    case 'llmapi': {
      const tps = Math.max(1, p.tokensPerSec ?? 80)
      const latencyMs = (p.ttftMs ?? 0) + (tout / tps) * 1000
      const tokensPerReq = Math.max(1, tin + tout)
      return {
        latencyMs,
        maxRps: Math.max(1e-6, (p.tpmLimit ?? 1e6) / tokensPerReq / 60),
        costPerReq: llmApiCostPerReq(p),
        perStreamTps: tps,
        tokensPerReq,
      }
    }
    case 'gpullm': {
      const batch = Math.max(1, p.batchSize ?? 1)
      const perStream = Math.max(0.1, (p.tokensPerSec ?? 50) / batchSlowdown(batch))
      // prefill (обработка входа) ~ в 50 раз быстрее decode
      const prefillMs = (tin / (perStream * 50)) * 1000
      const latencyMs = (p.ttftMs ?? 0) + prefillMs + (tout / perStream) * 1000
      return { latencyMs, maxRps: batch / (latencyMs / 1000), costPerReq: 0, perStreamTps: perStream, tokensPerReq: tin + tout }
    }
    case 'embedding': {
      const tps = Math.max(1, p.throughputTps ?? 10000)
      return {
        latencyMs: p.latencyMs + (tin / tps) * 1000 * 4, // небольшой batch на запрос
        maxRps: tps / Math.max(1, tin),
        costPerReq: (tin * (p.costPer1MIn ?? 0)) / 1e6,
        tokensPerReq: tin,
      }
    }
    case 'vectordb': {
      const recall = Math.min(100, Math.max(50, p.recall ?? 95))
      const recallFactor = recall > 90 ? 1 + ((recall - 90) / 10) * 1.5 : 1
      const sizeFactor = 1 + 0.25 * Math.log10(Math.max(1, (p.indexM ?? 1) * 10))
      return { latencyMs: p.latencyMs * sizeFactor * recallFactor, maxRps: p.maxRps / recallFactor / sizeFactor, costPerReq: 0 }
    }
  }
  return null
}

/** Подставить производные (токенные) значения maxRps/latency/цены в параметры */
export function deriveNode(n: SimNode): SimNode {
  const info = tokenInfo(n.kind, n.params)
  if (!info) return n
  const params: Params = { ...n.params, maxRps: info.maxRps, latencyMs: info.latencyMs, costPer1kReq: info.costPerReq * 1000 }
  if (n.kind === 'llmapi') params.instances = 1
  return { ...n, params }
}

export function deriveGraph(g: SimGraph): SimGraph {
  return { nodes: g.nodes.map(deriveNode), edges: g.edges }
}

export interface AiPeak {
  id: string
  peakUtil: number
  peakArrivals: number
  costMonth?: number
}

export interface AiRec {
  severity: 'critical' | 'warning' | 'info'
  node?: string
  title: string
  detail: string
}

/** Рекомендации, специфичные для AI-систем */
export function aiRecommendations(g: SimGraph, peaks: AiPeak[] = []): AiRec[] {
  const recs: AiRec[] = []
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const peak = new Map(peaks.map((p) => [p.id, p]))
  const llms = g.nodes.filter((n) => LLM_KINDS.includes(n.kind))
  if (!llms.length && !g.nodes.some((n) => n.kind === 'agent')) return recs
  const ancestors = (id: string) => {
    const seen = new Set<string>()
    const stack = [id]
    while (stack.length) {
      const cur = stack.pop()!
      for (const e of g.edges) if (e.target === cur && !seen.has(e.source)) { seen.add(e.source); stack.push(e.source) }
    }
    return [...seen].map((x) => byId.get(x)!).filter(Boolean)
  }
  for (const n of llms) {
    const p = n.params
    const name = `«${n.label}»`
    const anc = ancestors(n.id)
    const pk = peak.get(n.id)
    if (!anc.some((a) => a.kind === 'semcache')) {
      recs.push({ severity: 'warning', node: n.id, title: `${name}: нет семантического кэша`, detail: 'Похожие вопросы каждый раз идут в LLM. Semantic cache перед моделью обычно снимает 20–60% вызовов и режет латентность с секунд до миллисекунд.' })
    }
    if (n.kind === 'gpullm' && (p.batchSize ?? 1) < 8) {
      recs.push({ severity: 'warning', node: n.id, title: `${name}: маленький batch (${p.batchSize})`, detail: 'GPU простаивает. Включите continuous batching (vLLM/TGI), batch 16–64: пропускная реплики вырастет в разы при небольшом росте латентности потока.' })
    }
    if (n.kind === 'llmapi' && (p.cachedInputPct ?? 0) < 30 && (p.inTokens ?? 0) >= 1024) {
      recs.push({ severity: 'info', node: n.id, title: `${name}: почти не используется prompt caching (${p.cachedInputPct ?? 0}%)`, detail: 'Вынесите неизменную часть (системный промпт, инструкции, few-shot) в начало запроса: кэшированные входные токены у OpenAI/Google стоят на 90% дешевле.' })
    }
    if (n.kind === 'llmapi' && pk && pk.peakUtil >= 0.7) {
      const info = tokenInfo('llmapi', p)!
      const needTpm = Math.ceil((pk.peakArrivals * info.tokensPerReq! * 60) / 0.7)
      recs.push({ severity: pk.peakUtil >= 0.95 ? 'critical' : 'warning', node: n.id, title: `${name}: упираемся в TPM лимит (${Math.round(pk.peakUtil * 100)}%)`, detail: `Нужно ~${(needTpm / 1e6).toFixed(1)}M TPM. Запросите повышение квоты, распределите нагрузку по нескольким ключам/регионам, добавьте fallback-провайдера и очередь с ретраями при 429. Сократите входной контекст.` })
    }
    if ((p.outTokens ?? 0) >= 400 || (p.inTokens ?? 0) >= 3000) {
      recs.push({ severity: 'info', node: n.id, title: `${name}: много токенов на запрос (${p.inTokens ?? 0} in / ${p.outTokens ?? 0} out)`, detail: 'Латентность и цена линейно растут от токенов. Сожмите промпт, уменьшите top-k чанков, ограничьте max_tokens, используйте стриминг ответа.' })
    }
    const perReq = tokenInfo(n.kind, p)?.costPerReq ?? 0
    if (perReq > 0.002 || (n.kind === 'gpullm' && modelScale(p.model).gpus > 1)) {
      recs.push({ severity: 'info', node: n.id, title: `${name}: дорогая модель на все запросы`, detail: `${perReq > 0 ? `≈$${perReq.toFixed(4)} за запрос. ` : ''}Model routing: классификатор отправляет простые запросы на маленькую модель (8B / mini), сложные — на большую. Обычно это экономит 50–80% стоимости.` })
    }
  }
  for (const n of g.nodes.filter((x) => x.kind === 'agent')) {
    const s = n.params.steps ?? 1
    const calls = g.edges.filter((e) => e.source === n.id && e.data.mode === 'call').reduce((acc, e) => acc + e.data.weight, 0)
    if (s >= 5) recs.push({ severity: 'warning', node: n.id, title: `«${n.label}»: ${s} шагов на запрос (≈${Math.round(s * calls)} вызовов)`, detail: 'Каждый шаг агента — новый вызов LLM и инструментов, латентность складывается. Ограничьте max steps, вызывайте инструменты параллельно, кэшируйте результаты tools, давайте агенту план заранее.' })
  }
  if (!g.nodes.some((n) => n.kind === 'guardrails')) {
    recs.push({ severity: 'info', title: 'Нет guardrails', detail: 'LLM без модерации входа/выхода: риск prompt injection, утечки PII и токсичных ответов. Поставьте Guardrails перед моделью — заодно отсеете мусор до дорогого вызова.' })
  }
  for (const n of g.nodes.filter((x) => x.kind === 'vectordb')) {
    if ((n.params.recall ?? 95) < 90) recs.push({ severity: 'warning', node: n.id, title: `«${n.label}»: низкий recall (${n.params.recall}%)`, detail: 'Поиск теряет релевантные чанки — LLM отвечает хуже или галлюцинирует. Поднимите ef/nprobe или добавьте reranker.' })
    if ((n.params.indexM ?? 0) >= 50 && n.params.instances < 3) recs.push({ severity: 'info', node: n.id, title: `«${n.label}»: большой индекс (${n.params.indexM}M) на ${n.params.instances} репликах`, detail: 'Шардируйте коллекцию и держите ≥3 реплики; подумайте о квантовании векторов (PQ/int8), чтобы индекс помещался в RAM.' })
  }
  for (const n of g.nodes.filter((x) => x.kind === 'semcache')) {
    if ((n.params.hitRatio ?? 0) < 20) recs.push({ severity: 'info', node: n.id, title: `«${n.label}»: hit ratio ${n.params.hitRatio}%`, detail: 'Подберите порог похожести, нормализуйте запросы, кэшируйте ответы на частые интенты (FAQ).' })
  }
  return recs
}
