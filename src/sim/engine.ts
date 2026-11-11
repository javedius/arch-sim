import { deriveGraph } from './ai'
import { regionLatency } from './catalog'
import type {
  EdgeData, Faults, GlobalMetrics, Kind, LoadInput, NodeMetrics, SimEdge, SimGraph, SimNode, SimState, TickResult,
} from './types'

/* ---------- утилиты ---------- */

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Erlang C: вероятность, что запрос будет ждать в очереди M/M/c. a = λ/μ (нагрузка в эрлангах) */
export function erlangC(c: number, a: number): number {
  if (c <= 0) return 1
  if (a <= 0) return 0
  if (a >= c) return 1
  // Erlang B рекурсией — численно устойчиво
  let b = 1
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b)
  const rho = a / c
  return b / (1 - rho * (1 - b))
}

export interface PoolRt {
  c: number
  mu: number
  lambda: number
  rho: number
  pWait: number
  meanWaitMs: number
  dropP: number
}

/** Модель пула из c серверов с интенсивностью μ (rps на сервер), приход λ rps */
export function mmc(lambda: number, mu: number, c: number, timeoutMs: number): PoolRt {
  if (lambda <= 0) return { c, mu, lambda: 0, rho: 0, pWait: 0, meanWaitMs: 0, dropP: 0 }
  if (c <= 0 || mu <= 0) return { c, mu, lambda, rho: 1, pWait: 1, meanWaitMs: timeoutMs, dropP: 1 }
  const cap = c * mu
  const rho = lambda / cap
  if (rho < 1) {
    // для гигантских c ограничим вычисления: распределение ожидания всё равно ~0
    const cc = Math.min(c, 5000)
    const scale = cc / c
    const pWait = erlangC(cc, (lambda / mu) * scale)
    const meanWaitMs = Math.min(timeoutMs, (pWait / (cap - lambda)) * 1000)
    return { c, mu, lambda, rho, pWait, meanWaitMs, dropP: 0 }
  }
  return { c, mu, lambda, rho, pWait: 1, meanWaitMs: timeoutMs * 0.8, dropP: 1 - cap / lambda }
}

/* ---------- runtime ---------- */

interface NodeRt {
  node: SimNode
  bypass?: boolean
  r: number
  w: number
  down: boolean
  rejectP: number
  errP: number
  hitP: number
  readPool: PoolRt
  writePool: PoolRt
  instances: number
  capacity: number
  routeR: { edge: SimEdge; share: number }[]
  routeW: { edge: SimEdge; share: number }[]
  backlog?: number
  lagSec?: number
  hits: number
}

export interface SimOptions {
  dt?: number // шаг симуляции, сек
  samples?: number // сэмплов Монте-Карло для перцентилей
  timeoutMs?: number
  /** autoscaling в установившемся режиме: инстансов ровно столько, чтобы загрузка была ~70% */
  steadyAutoscale?: boolean
}

export function initialState(seed = 42): SimState {
  return { t: 0, backlog: {}, instances: {}, lastScale: {}, seed }
}

const GLOBAL_KINDS: Kind[] = ['dns', 'cdn', 'client']

export function edgeExtraLatency(a: SimNode, b: SimNode): number {
  if (GLOBAL_KINDS.includes(b.kind) || (GLOBAL_KINDS.includes(a.kind) && a.kind !== 'client')) return 0
  return regionLatency(a.params.region, b.params.region)
}

function allows(d: EdgeData, type: 'r' | 'w') {
  return d.filter === 'all' || (type === 'r' ? d.filter === 'read' : d.filter === 'write')
}

/** Порядок обхода: DFS от клиентов, обратные рёбра (циклы) игнорируются */
export function orderGraph(g: SimGraph) {
  const out = new Map<string, SimEdge[]>()
  g.nodes.forEach((n) => out.set(n.id, []))
  g.edges.forEach((e) => {
    if (out.has(e.source) && out.has(e.target)) out.get(e.source)!.push(e)
  })
  const color = new Map<string, number>()
  const post: string[] = []
  const ignored = new Set<string>()
  const visit = (id: string) => {
    color.set(id, 1)
    for (const e of out.get(id) ?? []) {
      const c = color.get(e.target) ?? 0
      if (c === 1) ignored.add(e.id)
      else if (c === 0) visit(e.target)
    }
    color.set(id, 2)
    post.push(id)
  }
  const roots = [...g.nodes.filter((n) => n.kind === 'client'), ...g.nodes.filter((n) => n.kind !== 'client')]
  roots.forEach((n) => {
    if (!color.get(n.id)) visit(n.id)
  })
  return { order: post.reverse(), out, ignored }
}

function effInstances(n: SimNode, state: SimState): number {
  const p = n.params
  if (p.autoscale && n.kind !== 'sqldb') {
    const s = state.instances[n.id]
    if (s !== undefined && s >= p.instances) return Math.min(s, Math.max(p.maxInstances ?? p.instances, p.instances))
  }
  return p.instances
}

export function simulateTick(
  rawGraph: SimGraph,
  load: LoadInput,
  prev: SimState,
  faults: Faults = {},
  opts: SimOptions = {},
): TickResult {
  // токенные компоненты: латентность/ёмкость/цена вычисляются из токенов
  const graph = deriveGraph(rawGraph)
  const dt = opts.dt ?? 1
  const samples = opts.samples ?? 1500
  const timeoutMs = opts.timeoutMs ?? 3000
  const state: SimState = {
    t: prev.t,
    backlog: { ...prev.backlog },
    instances: { ...prev.instances },
    lastScale: { ...prev.lastScale },
    seed: prev.seed,
  }
  const warnings: string[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const { order, out, ignored } = orderGraph(graph)
  if (ignored.size) warnings.push('В графе есть циклы — обратные связи не учитываются в потоке.')

  const clients = graph.nodes.filter((n) => n.kind === 'client')
  if (!clients.length) warnings.push('Нет узла «Клиенты» — некому генерировать трафик.')
  const shareSum = clients.reduce((s, c) => s + Math.max(0, c.params.trafficShare ?? 100), 0) || 1

  const arr = new Map<string, { r: number; w: number }>()
  graph.nodes.forEach((n) => arr.set(n.id, { r: 0, w: 0 }))
  const rps = Math.max(0, load.rps)
  const readRatio = Math.min(1, Math.max(0, load.readRatio))
  clients.forEach((c) => {
    const share = Math.max(0, c.params.trafficShare ?? 100) / shareSum
    arr.set(c.id, { r: rps * share * readRatio, w: rps * share * (1 - readRatio) })
  })

  const rts = new Map<string, NodeRt>()
  const edgeFlow: Record<string, number> = {}
  graph.edges.forEach((e) => (edgeFlow[e.id] = 0))

  const isDown = (id: string) => {
    const n = byId.get(id)
    if (!n) return true
    const f = faults[id]
    if (f?.down) return true
    if (f?.lostInstances && n.kind !== 'sqldb' && n.kind !== 'client') {
      return effInstances(n, state) - f.lostInstances <= 0
    }
    return false
  }
  const nodeCapacity = (n: SimNode) => {
    if (isDown(n.id)) return 0
    const lost = faults[n.id]?.lostInstances ?? 0
    return Math.max(0, effInstances(n, state) - lost) * n.params.maxRps
  }

  for (const id of order) {
    const n = byId.get(id)!
    const p = n.params
    const { r, w } = arr.get(id)!
    const f = faults[id] ?? {}
    if (opts.steadyAutoscale && p.autoscale && n.kind !== 'sqldb' && n.kind !== 'client') {
      const max = Math.max(p.maxInstances ?? p.instances, p.instances)
      state.instances[id] = Math.min(max, Math.max(p.instances, Math.ceil((r + w) / Math.max(1e-9, p.maxRps * 0.7))))
    }
    // упавший кэш приложение обходит (cache-aside): все чтения идут дальше, в БД
    const bypass = (n.kind === 'cache' || n.kind === 'semcache') && isDown(id)
    const down = !bypass && isDown(id)
    const lost = f.lostInstances ?? 0
    let instances = Math.max(0, effInstances(n, state) - lost)
    let rejectP = 0
    let readPool: PoolRt
    let writePool: PoolRt
    const lambda = r + w

    if (n.kind === 'client') {
      readPool = writePool = mmc(0, 1, 1, timeoutMs)
      instances = 0
    } else if (n.kind === 'sqldb') {
      const shards = Math.max(1, p.shards ?? 1)
      let replicas = Math.max(0, p.replicas ?? 0)
      let primaries = shards
      // потеря AZ: сначала теряются реплики, при 1 AZ — всё
      if (lost > 0) {
        const lostRep = Math.min(replicas, lost)
        replicas -= lostRep
        if (lost - lostRep > 0) primaries = 0
      }
      if (f.primaryDownSince !== undefined) {
        const since = state.t - f.primaryDownSince
        if (since < (p.failoverSec ?? 30) || replicas === 0) primaries = 0
        else replicas = Math.max(0, replicas - 1) // реплика стала primary
      }
      if (down) primaries = replicas = 0
      instances = (primaries > 0 ? shards : 0) + replicas * shards
      if (replicas > 0) {
        writePool = mmc(w, p.maxRps, primaries, timeoutMs)
        readPool = mmc(r, p.maxRps, replicas * shards, timeoutMs)
      } else {
        readPool = writePool = mmc(lambda, p.maxRps, primaries, timeoutMs)
      }
    } else {
      let admitted = lambda
      if (n.kind === 'ratelimiter' && p.limitRps && lambda > p.limitRps) {
        rejectP = 1 - p.limitRps / lambda
        admitted = p.limitRps
      }
      if (n.kind === 'guardrails' && (p.blockRate ?? 0) > 0) {
        rejectP = Math.min(1, (p.blockRate ?? 0) / 100)
      }
      if (n.kind === 'llmapi') {
        // провайдер не держит очередь: сверх TPM — сразу 429
        const cap = p.maxRps * Math.max(1, instances)
        if (lambda > cap) rejectP = 1 - cap / lambda
        const rho = lambda / cap
        readPool = writePool = { c: Math.max(1, instances), mu: p.maxRps, lambda: Math.min(lambda, cap), rho, pWait: 0, meanWaitMs: 0, dropP: down ? 1 : 0 }
      } else readPool = writePool = mmc(admitted, p.maxRps, down ? 0 : instances, timeoutMs)
    }
    if (down) {
      readPool = { ...readPool, dropP: lambda > 0 ? 1 : 0 }
      writePool = readPool === writePool ? readPool : { ...writePool, dropP: lambda > 0 ? 1 : 0 }
    }
    const errP = Math.min(1, Math.max(0, p.failureRate / 100))
    if (bypass) readPool = writePool = mmc(0, 1, 1, timeoutMs)
    const hitP = bypass ? 0 : n.kind === 'cdn' || n.kind === 'cache' || n.kind === 'semcache' ? Math.min(1, Math.max(0, (p.hitRatio ?? 0) / 100)) : 0

    const passR = down ? 0 : (1 - rejectP) * (1 - readPool.dropP) * (1 - errP)
    const passW = down ? 0 : (1 - rejectP) * (1 - writePool.dropP) * (1 - errP)
    let fr = r * passR
    let fw = w * passW
    const hits = fr * hitP
    fr -= hits

    const edges = (out.get(id) ?? []).filter((e) => !ignored.has(e.id) && byId.has(e.target))
    const rt: NodeRt = {
      node: n, r, w, down, bypass, rejectP, errP, hitP, readPool, writePool, instances,
      capacity: n.kind === 'client' ? 0 : (readPool === writePool ? readPool.c * p.maxRps : (readPool.c + writePool.c) * p.maxRps),
      routeR: [], routeW: [], hits,
    }

    // очередь: асинхронная доставка воркерам с backlog
    let asyncAmount = 0
    const asyncEdges = edges.filter((e) => e.data.async)
    if (n.kind === 'queue' || asyncEdges.length) {
      const incoming = asyncEdges.length ? fr + fw : 0
      const consumerCap = asyncEdges.reduce((s, e) => {
        const t = byId.get(e.target)!
        let cap = nodeCapacity(t)
        if (n.kind === 'queue' && p.partitions) cap = Math.min(cap, p.partitions * t.params.maxRps)
        return s + cap
      }, 0)
      const backlog = state.backlog[id] ?? 0
      const consumed = Math.min(incoming + backlog / dt, consumerCap)
      const nb = Math.max(0, backlog + (incoming - consumed) * dt)
      state.backlog[id] = nb
      rt.backlog = nb
      rt.lagSec = consumed > 0 ? nb / consumed : nb > 0 ? Infinity : 0
      asyncAmount = consumed
      if (asyncEdges.length) {
        const ws = asyncEdges.reduce((s, e) => s + Math.max(0, e.data.weight), 0) || 1
        asyncEdges.forEach((e) => {
          const amt = (asyncAmount * Math.max(0, e.data.weight)) / ws
          edgeFlow[e.id] += amt
          arr.get(e.target)!.w += amt
        })
      }
    }

    const sync = edges.filter((e) => !e.data.async)
    const stepMul = n.kind === 'agent' ? Math.max(1, p.steps ?? 1) : 1
    const distribute = (amount: number, type: 'r' | 'w') => {
      const eligible = sync.filter((e) => allows(e.data, type))
      const routes = eligible.filter((e) => e.data.mode === 'route')
      const calls = eligible.filter((e) => e.data.mode === 'call')
      if (routes.length) {
        const healthy = routes.filter((e) => !isDown(e.target))
        const pool = healthy.length ? healthy : routes
        const weightOf = (e: SimEdge) => {
          if (n.kind === 'loadbalancer') {
            if (p.algorithm === 'least-conn') return Math.max(1e-9, nodeCapacity(byId.get(e.target)!))
            if (p.algorithm === 'round-robin') return 1
          }
          return Math.max(0, e.data.weight)
        }
        const total = pool.reduce((s, e) => s + weightOf(e), 0) || 1
        const list = pool.map((e) => ({ edge: e, share: weightOf(e) / total }))
        if (type === 'r') rt.routeR = list
        else rt.routeW = list
        list.forEach(({ edge, share }) => {
          const amt = amount * share
          edgeFlow[edge.id] += amt
          const a = arr.get(edge.target)!
          if (type === 'r') a.r += amt
          else a.w += amt
        })
      }
      calls.forEach((e) => {
        const amt = amount * Math.max(0, e.data.weight) * stepMul
        edgeFlow[e.id] += amt
        const a = arr.get(e.target)!
        if (type === 'r') a.r += amt
        else a.w += amt
      })
    }
    distribute(fr, 'r')
    distribute(fw, 'w')
    rts.set(id, rt)
  }

  /* ---------- метрики узлов ---------- */
  const nodes: Record<string, NodeMetrics> = {}
  let costMonth = 0
  let maxUtil = 0
  let bottleneck: string | undefined
  for (const [id, rt] of rts) {
    const n = rt.node
    const p = n.params
    const lambda = rt.r + rt.w
    const rejected = lambda * rt.rejectP
    const admitted = lambda - rejected
    const rDrop = rt.r * (1 - rt.rejectP) * rt.readPool.dropP
    const wDrop = rt.w * (1 - rt.rejectP) * rt.writePool.dropP
    const dropped = rt.down ? admitted : rDrop + wDrop
    const served = Math.max(0, admitted - dropped)
    const errors = served * rt.errP
    const util = n.kind === 'client' ? 0 : Math.max(rt.readPool.rho, rt.writePool.rho)
    const ownLat = p.latencyMs + (rt.r * rt.readPool.meanWaitMs + rt.w * rt.writePool.meanWaitMs) / (lambda || 1)
    let billedInstances = rt.instances
    if (n.kind === 'sqldb') billedInstances = Math.max(1, p.shards ?? 1) * (1 + Math.max(0, p.replicas ?? 0))
    else if (n.kind !== 'client') billedInstances = Math.max(effInstances(n, state), 1)
    const cost = n.kind === 'client' ? 0 : billedInstances * p.costPerHour * 730 + ((p.costPer1kReq ?? 0) * served * 2_628_000) / 1000
    costMonth += cost
    let status: NodeMetrics['status'] = 'ok'
    if (rt.down || rt.bypass || (rt.instances === 0 && n.kind !== 'client')) status = 'down'
    else if (lambda <= 0) status = 'idle'
    else if (util >= 0.85 || dropped / (lambda || 1) > 0.005 || (rt.lagSec ?? 0) > 30) status = 'hot'
    else if (util >= 0.6 || (rt.lagSec ?? 0) > 5) status = 'warn'
    if (n.kind === 'client') status = lambda > 0 ? 'ok' : 'idle'
    nodes[id] = {
      arrivals: lambda, reads: rt.r, writes: rt.w, served, dropped, rejected, errors,
      utilization: util, latencyMs: ownLat, instances: n.kind === 'client' ? 0 : rt.instances,
      capacity: rt.capacity, costMonth: cost, backlog: rt.backlog, lagSec: rt.lagSec, hits: rt.hits, status,
    }
    if (n.kind !== 'client' && lambda > 0 && util > maxUtil) {
      maxUtil = util
      bottleneck = id
    }
  }

  /* ---------- Монте-Карло: сквозная латентность ---------- */
  const rand = mulberry32((state.seed + Math.floor(state.t * 1000)) >>> 0)
  const lognorm = () => {
    // Box–Muller
    const u = Math.max(1e-12, rand())
    const v = rand()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return Math.exp(0.3 * z - 0.045)
  }
  const expo = (mean: number) => -Math.log(Math.max(1e-12, 1 - rand())) * mean
  type Outcome = { ms: number; res: 'ok' | 'error' | 'rejected' }
  const traverse = (id: string, type: 'r' | 'w', depth: number): Outcome => {
    const rt = rts.get(id)
    if (!rt) return { ms: 0, res: 'error' }
    const n = rt.node
    if (rt.down) return { ms: Math.min(timeoutMs, 30), res: 'error' }
    // 429 от LLM-провайдера ломает запрос пользователя (ошибка), а rate limiter/guardrails — штатный отказ
    if (rt.rejectP > 0 && rand() < rt.rejectP) return { ms: n.params.latencyMs, res: n.kind === 'llmapi' ? 'error' : 'rejected' }
    const pool = type === 'r' ? rt.readPool : rt.writePool
    if (pool.dropP > 0 && rand() < pool.dropP) return { ms: timeoutMs, res: 'error' }
    let ms = rt.bypass ? 2 : n.params.latencyMs * lognorm()
    if (pool.pWait > 0 && rand() < pool.pWait) ms += Math.min(timeoutMs, expo(pool.meanWaitMs / Math.max(pool.pWait, 1e-9)))
    if (rt.errP > 0 && rand() < rt.errP) return { ms, res: 'error' }
    if (type === 'r' && rt.hitP > 0 && rand() < rt.hitP) return { ms, res: 'ok' }
    if (depth > 40) return { ms, res: 'ok' }
    const edges = (out.get(id) ?? []).filter((e) => !ignored.has(e.id) && !e.data.async && byId.has(e.target) && allows(e.data, type))
    const routes = type === 'r' ? rt.routeR : rt.routeW
    const hop = (e: SimEdge): Outcome => {
      const child = traverse(e.target, type, depth + 1)
      return { ms: child.ms + edgeExtraLatency(n, byId.get(e.target)!), res: child.res }
    }
    if (routes.length) {
      let x = rand()
      let chosen = routes[routes.length - 1].edge
      for (const { edge, share } of routes) {
        if ((x -= share) <= 0) {
          chosen = edge
          break
        }
      }
      const o = hop(chosen)
      ms += o.ms
      if (o.res !== 'ok') return { ms, res: o.res }
    }
    const steps = n.kind === 'agent' ? Math.max(1, Math.round(n.params.steps ?? 1)) : 1
    for (let s = 0; s < steps; s++) {
      for (const e of edges) {
        if (e.data.mode !== 'call') continue
        const wgt = Math.max(0, e.data.weight)
        const calls = Math.floor(wgt) + (rand() < wgt - Math.floor(wgt) ? 1 : 0)
        for (let i = 0; i < calls; i++) {
          const o = hop(e)
          ms += o.ms
          if (o.res !== 'ok') return { ms, res: o.res }
        }
      }
    }
    return { ms, res: 'ok' }
  }

  const lat: number[] = []
  let errs = 0
  let rej = 0
  let total = 0
  if (clients.length && rps > 0) {
    for (let i = 0; i < samples; i++) {
      let x = rand() * shareSum
      let c = clients[clients.length - 1]
      for (const cl of clients) {
        if ((x -= Math.max(0, cl.params.trafficShare ?? 100)) <= 0) {
          c = cl
          break
        }
      }
      const type = rand() < readRatio ? 'r' : 'w'
      const o = traverse(c.id, type, 0)
      total++
      if (o.res === 'ok') lat.push(o.ms)
      else if (o.res === 'error') errs++
      else rej++
    }
  }
  lat.sort((a, b) => a - b)
  const pct = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0)
  const errorRate = total ? errs / total : 0
  const rejectedRate = total ? rej / total : 0
  const global: GlobalMetrics = {
    offered: rps,
    throughput: rps * (1 - errorRate - rejectedRate),
    errorRate,
    rejectedRate,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    avg: lat.length ? lat.reduce((s, x) => s + x, 0) / lat.length : 0,
    costMonth,
    bottleneck: maxUtil >= 0.6 ? bottleneck : undefined,
    maxUtil,
  }

  /* ---------- autoscaling ---------- */
  for (const n of graph.nodes) {
    const p = n.params
    if (!p.autoscale || n.kind === 'sqldb' || n.kind === 'client') continue
    const cur = effInstances(n, state)
    const m = nodes[n.id]
    const last = state.lastScale[n.id] ?? -Infinity
    if (state.t - last < 10) {
      state.instances[n.id] = cur
      continue
    }
    const max = Math.max(p.maxInstances ?? p.instances, p.instances)
    if (m.utilization > 0.7 && cur < max) {
      state.instances[n.id] = Math.min(max, Math.max(cur + 1, Math.ceil(cur * 1.3)))
      state.lastScale[n.id] = state.t
    } else if (m.utilization < 0.3 && cur > p.instances) {
      state.instances[n.id] = Math.max(p.instances, Math.floor(cur * 0.8))
      state.lastScale[n.id] = state.t
    } else state.instances[n.id] = cur
  }

  state.t += dt
  return { nodes, edges: edgeFlow, global, state, warnings }
}

/* ---------- паттерны нагрузки ---------- */
export type Pattern = 'constant' | 'ramp' | 'spike' | 'wave'

export function patternRps(pattern: Pattern, base: number, t: number, period = 120): number {
  const ph = ((t % period) + period) % period
  switch (pattern) {
    case 'constant':
      return base
    case 'ramp':
      return base * Math.min(1, ph / (period * 0.8))
    case 'spike':
      return ph > period * 0.45 && ph < period * 0.6 ? base * 5 : base
    case 'wave': {
      // «сутки»: ночью ~20% пика, короткий вечерний пик 100%, среднее ≈ 54% пика
      return base * (0.2 + 0.8 * Math.abs(Math.sin((Math.PI * ph) / period)) ** 3)
    }
  }
}

export const PATTERN_LABELS: Record<Pattern, string> = {
  constant: 'Постоянная',
  ramp: 'Рост (ramp)',
  spike: 'Всплеск ×5 (spike)',
  wave: 'Суточная волна',
}
