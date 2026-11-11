import { aiRecommendations, deriveGraph } from './ai'
import { CATALOG } from './catalog'
import { initialState, simulateTick } from './engine'
import type { Faults, SimGraph, TickResult } from './types'

export type ScenarioId = 'load' | 'stress' | 'spike' | 'soak' | 'failover' | 'az' | 'cache' | 'db'

export interface ScenarioDef {
  id: ScenarioId
  title: string
  goal: string
  durationSec: number
  step: number
  needsTarget?: boolean
  load: (t: number, base: number) => number
  faults: (t: number, g: SimGraph, target?: string) => Faults
}

const FAULT_AT = 60

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'load', title: 'Нагрузочный тест (Load)', durationSec: 300, step: 2,
    goal: 'Держит ли система целевую нагрузку стабильно 5 минут и укладывается ли в SLO.',
    load: (_t, b) => b, faults: () => ({}),
  },
  {
    id: 'stress', title: 'Стресс-тест (Stress)', durationSec: 600, step: 3,
    goal: 'Плавно поднимаем нагрузку до ×4 от целевой и ищем точку отказа — где первым ломается система.',
    load: (t, b) => b * 4 * (t / 600), faults: () => ({}),
  },
  {
    id: 'spike', title: 'Пиковый тест (Spike)', durationSec: 240, step: 1,
    goal: 'Резкий всплеск ×5 на 40 секунд (распродажа, пуш-рассылка). Смотрим ошибки и восстановление.',
    load: (t, b) => (t >= 90 && t < 130 ? b * 5 : b), faults: () => ({}),
  },
  {
    id: 'soak', title: 'Длительный тест (Soak)', durationSec: 4 * 3600, step: 60,
    goal: '4 часа под 80% нагрузки: копятся ли очереди (lag), стабильна ли латентность, сколько стоит.',
    load: (_t, b) => b * 0.8, faults: () => ({}),
  },
  {
    id: 'failover', title: 'Отказ узла (Failover)', durationSec: 240, step: 1, needsTarget: true,
    goal: 'На 60-й секунде «убиваем» выбранный узел на 2 минуты. Переживёт ли система без него?',
    load: (_t, b) => b,
    faults: (t, _g, target) => (target && t >= FAULT_AT && t < FAULT_AT + 120 ? { [target]: { down: true } } : {}),
  },
  {
    id: 'az', title: 'Отказ зоны доступности (AZ)', durationSec: 240, step: 1,
    goal: 'На 60-й секунде падает одна AZ: каждый узел теряет свою долю инстансов, узлы в 1 AZ — целиком.',
    load: (_t, b) => b,
    faults: (t, g) => {
      if (t < FAULT_AT || t >= FAULT_AT + 120) return {}
      const f: Faults = {}
      g.nodes.forEach((n) => {
        if (n.kind === 'client') return
        const az = Math.max(1, n.params.azCount)
        if (az === 1) f[n.id] = { down: true }
        else if (['dns', 'cdn', 'objectstorage', 'external', 'llmapi'].includes(n.kind)) return // managed-сервис переживает потерю зоны
        else if (n.kind === 'sqldb') {
          const total = (n.params.replicas ?? 0) + 1
          f[n.id] = { lostInstances: Math.ceil(total / az) }
        } else f[n.id] = { lostInstances: Math.ceil(n.params.instances / az) }
      })
      return f
    },
  },
  {
    id: 'cache', title: 'Падение кэша', durationSec: 240, step: 1,
    goal: 'Все кэши (Redis/Memcached) недоступны 2 минуты — вся нагрузка идёт в БД (thundering herd).',
    load: (_t, b) => b,
    faults: (t, g) => {
      if (t < FAULT_AT || t >= FAULT_AT + 120) return {}
      const f: Faults = {}
      g.nodes.filter((n) => n.kind === 'cache').forEach((n) => (f[n.id] = { down: true }))
      return f
    },
  },
  {
    id: 'db', title: 'Падение primary БД', durationSec: 240, step: 1,
    goal: 'Primary SQL-базы падает на 60-й секунде. Запись недоступна до промоута реплики (failover).',
    load: (_t, b) => b,
    faults: (t, g) => {
      if (t < FAULT_AT) return {}
      const f: Faults = {}
      g.nodes.filter((n) => n.kind === 'sqldb').forEach((n) => (f[n.id] = { primaryDownSince: FAULT_AT }))
      return f
    },
  },
]

export interface SeriesPoint {
  t: number
  offered: number
  throughput: number
  errorPct: number
  rejectedPct: number
  p50: number
  p95: number
  p99: number
  costMonth: number
  maxUtil: number
  [key: string]: number
}

export interface NodePeak {
  id: string
  label: string
  kind: string
  peakUtil: number
  peakArrivals: number
  maxDropPct: number
  maxBacklog: number
  maxLagSec: number
  avgUtil: number
  capacity: number
  instances: number
}

export interface Slo {
  p99Ms: number
  errorPct: number
}

export interface Recommendation {
  severity: 'critical' | 'warning' | 'info'
  node?: string
  title: string
  detail: string
}

export interface ScenarioResult {
  scenario: ScenarioDef
  baseRps: number
  series: SeriesPoint[]
  peaks: NodePeak[]
  summary: {
    maxP99: number
    avgP99: number
    maxErrorPct: number
    avgErrorPct: number
    peakThroughput: number
    avgCostMonth: number
    breakingRps?: number
    recoverySec?: number
    passed: boolean
    sloViolations: string[]
  }
  recommendations: Recommendation[]
}

export function runScenario(
  graph: SimGraph,
  id: ScenarioId,
  opts: { baseRps: number; readRatio: number; slo: Slo; target?: string; samples?: number },
): ScenarioResult {
  const sc = SCENARIOS.find((s) => s.id === id)!
  let state = initialState(7)
  const series: SeriesPoint[] = []
  const peaks = new Map<string, NodePeak & { utilSum: number; n: number }>()
  graph.nodes.forEach((n) =>
    peaks.set(n.id, {
      id: n.id, label: n.label, kind: n.kind, peakUtil: 0, peakArrivals: 0, maxDropPct: 0, maxBacklog: 0, maxLagSec: 0,
      avgUtil: 0, utilSum: 0, n: 0, capacity: 0, instances: n.params.instances,
    }),
  )
  let breakingRps: number | undefined
  let baselineP99: number | undefined
  let last: TickResult | undefined
  for (let t = 0; t <= sc.durationSec; t += sc.step) {
    state.t = t
    const rps = sc.load(t, opts.baseRps)
    const res = simulateTick(graph, { rps, readRatio: opts.readRatio }, state, sc.faults(t, graph, opts.target), {
      dt: sc.step, samples: opts.samples ?? 800,
    })
    state = res.state
    last = res
    const point: SeriesPoint = {
      t, offered: rps, throughput: res.global.throughput, errorPct: res.global.errorRate * 100,
      rejectedPct: res.global.rejectedRate * 100, p50: res.global.p50, p95: res.global.p95, p99: res.global.p99,
      costMonth: res.global.costMonth, maxUtil: res.global.maxUtil * 100,
    }
    for (const n of graph.nodes) {
      const m = res.nodes[n.id]
      if (!m) continue
      point['u_' + n.id] = Math.min(100, m.utilization * 100)
      const pk = peaks.get(n.id)!
      pk.peakUtil = Math.max(pk.peakUtil, m.utilization)
      pk.peakArrivals = Math.max(pk.peakArrivals, m.arrivals)
      pk.maxDropPct = Math.max(pk.maxDropPct, m.arrivals > 0 ? (m.dropped / m.arrivals) * 100 : 0)
      pk.maxBacklog = Math.max(pk.maxBacklog, m.backlog ?? 0)
      pk.maxLagSec = Math.max(pk.maxLagSec, Number.isFinite(m.lagSec ?? 0) ? (m.lagSec ?? 0) : 1e9)
      pk.utilSum += m.utilization
      pk.n++
      pk.capacity = Math.max(pk.capacity, m.capacity)
      pk.instances = Math.max(pk.instances, m.instances)
    }
    if (baselineP99 === undefined && rps > 0 && point.p99 > 0) baselineP99 = point.p99
    const p99Limit = Math.max(opts.slo.p99Ms, (baselineP99 ?? 0) * 3)
    if (breakingRps === undefined && rps > 0 && t > 0 && (point.errorPct > opts.slo.errorPct || point.p99 > p99Limit)) breakingRps = rps
    series.push(point)
  }
  void last
  const peakList: NodePeak[] = [...peaks.values()].map(({ utilSum, n, ...p }) => ({ ...p, avgUtil: n ? utilSum / n : 0 }))

  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0)
  const maxP99 = Math.max(0, ...series.map((p) => p.p99))
  const maxErr = Math.max(0, ...series.map((p) => p.errorPct))
  const violations: string[] = []
  const steady = sc.id === 'stress' ? series.filter((p) => p.offered <= opts.baseRps) : series
  const steadyP99 = Math.max(0, ...steady.map((p) => p.p99))
  const steadyErr = Math.max(0, ...steady.map((p) => p.errorPct))
  if (steadyP99 > opts.slo.p99Ms) violations.push(`p99 ${Math.round(steadyP99)} мс > SLO ${opts.slo.p99Ms} мс`)
  if (steadyErr > opts.slo.errorPct) violations.push(`ошибки ${steadyErr.toFixed(2)}% > SLO ${opts.slo.errorPct}%`)

  // время восстановления после окончания аварии/пика
  let recoverySec: number | undefined
  const endOfIncident = sc.id === 'spike' ? 130 : ['failover', 'az', 'cache'].includes(sc.id) ? FAULT_AT + 120 : sc.id === 'db' ? FAULT_AT : undefined
  if (endOfIncident !== undefined) {
    const after = series.filter((p) => p.t >= endOfIncident)
    const ok = after.find((p) => p.errorPct <= opts.slo.errorPct && p.p99 <= opts.slo.p99Ms)
    recoverySec = ok ? ok.t - endOfIncident : undefined
  }

  const result: ScenarioResult = {
    scenario: sc,
    baseRps: opts.baseRps,
    series,
    peaks: peakList,
    summary: {
      maxP99, avgP99: avg(series.map((p) => p.p99)), maxErrorPct: maxErr, avgErrorPct: avg(series.map((p) => p.errorPct)),
      peakThroughput: Math.max(0, ...series.map((p) => p.throughput)), avgCostMonth: avg(series.map((p) => p.costMonth)),
      breakingRps: sc.id === 'stress' ? breakingRps : undefined, recoverySec, passed: violations.length === 0, sloViolations: violations,
    },
    recommendations: [],
  }
  result.recommendations = recommend(graph, result, opts.slo)
  return result
}

/* ---------- рекомендации ---------- */

export function recommend(rawGraph: SimGraph, res: ScenarioResult | null, slo?: Slo, livePeaks?: NodePeak[]): Recommendation[] {
  const graph = deriveGraph(rawGraph)
  const recs: Recommendation[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const inc = (id: string) => graph.edges.filter((e) => e.target === id).map((e) => byId.get(e.source)).filter(Boolean)
  const kinds = new Set(graph.nodes.map((n) => n.kind))
  const peaks = res?.peaks ?? livePeaks ?? []

  for (const pk of peaks) {
    const n = byId.get(pk.id)
    if (!n || n.kind === 'client') continue
    const p = n.params
    const name = `«${n.label}»`
    if (pk.peakUtil >= 0.85 || pk.maxDropPct > 0.5) {
      if (n.kind === 'sqldb') {
        const hasCache = inc(n.id).some((s) => s!.kind === 'cache')
        recs.push({
          severity: 'critical', node: n.id, title: `${name}: база — бутылочное горло (пик ${Math.round(pk.peakUtil * 100)}%)`,
          detail: [
            !hasCache ? 'Поставьте кэш (Redis) перед БД для горячих чтений (cache-aside).' : 'Поднимите hit ratio кэша (TTL, прогрев, ключи).',
            (p.replicas ?? 0) < 2 ? `Добавьте read-реплики (сейчас ${p.replicas ?? 0}) — чтения уйдут с primary.` : '',
            'Если упирается запись — шардирование (сейчас шардов: ' + (p.shards ?? 1) + ') или выносите запись в очередь.',
          ].filter(Boolean).join(' '),
        })
      } else if (n.kind === 'llmapi') {
        // TPM-лимит разбирается в AI-рекомендациях
      } else if (n.kind === 'llm' || n.kind === 'gpullm') {
        const need = Math.ceil(pk.peakArrivals / (p.maxRps * 0.7))
        recs.push({
          severity: 'critical', node: n.id, title: `${name}: инференс не тянет (пик ${Math.round(pk.peakUtil * 100)}%)`,
          detail: `Нужно ~${need} GPU-реплик при 70% загрузке (сейчас ${p.instances}). Дешевле: семантический кэш ответов, батчинг (vLLM), модель меньше для простых запросов, стриминг, очередь для фоновых задач.`,
        })
      } else if (n.kind === 'external') {
        recs.push({
          severity: 'critical', node: n.id, title: `${name}: упираемся в лимит внешнего API`,
          detail: 'Кэшируйте ответы, делайте вызовы асинхронно через очередь, договоритесь о квоте. Обязательны таймауты, ретраи с backoff и circuit breaker.',
        })
      } else if (n.kind === 'ratelimiter') {
        // это нормально — rate limiter сам режет
      } else {
        const need = Math.ceil(pk.peakArrivals / (p.maxRps * 0.7))
        recs.push({
          severity: 'critical', node: n.id, title: `${name}: перегрузка (пик ${Math.round(pk.peakUtil * 100)}%, потери до ${pk.maxDropPct.toFixed(1)}%)`,
          detail: `Увеличьте инстансы до ~${Math.max(need, p.instances + 1)} (сейчас ${p.instances})${p.autoscale ? '' : ' или включите autoscaling'}. Либо поднимите мощность инстанса (CPU).`,
        })
      }
    } else if (pk.peakUtil >= 0.6) {
      recs.push({
        severity: 'warning', node: n.id, title: `${name}: мало запаса (пик ${Math.round(pk.peakUtil * 100)}%)`,
        detail: 'При росте трафика станет горлышком. Держите пиковую загрузку ниже 60–70%: добавьте инстанс или autoscaling.',
      })
    }
    if (n.kind === 'queue' && pk.maxLagSec > 10) {
      recs.push({
        severity: pk.maxLagSec > 60 ? 'critical' : 'warning', node: n.id, title: `${name}: растёт lag очереди (до ${pk.maxLagSec > 1e8 ? '∞' : Math.round(pk.maxLagSec) + ' с'})`,
        detail: `Воркеры не успевают разбирать сообщения. Добавьте воркеров (не больше числа партиций: ${p.partitions ?? '—'}) или увеличьте партиции.`,
      })
    }
    if (pk.avgUtil > 0 && pk.peakUtil < 0.15 && p.instances > 2 && p.costPerHour > 0.05) {
      recs.push({
        severity: 'info', node: n.id, title: `${name}: недогружен (пик ${Math.round(pk.peakUtil * 100)}%)`,
        detail: `Можно уменьшить число инстансов (${p.instances}) и сэкономить ~$${Math.round((p.instances - 2) * p.costPerHour * 730)}/мес.`,
      })
    }
  }

  // структурные проверки
  for (const n of graph.nodes) {
    if (n.kind === 'client' || ['dns', 'cdn', 'objectstorage', 'external', 'llmapi'].includes(n.kind)) continue
    const p = n.params
    const name = `«${n.label}»`
    const single = n.kind === 'sqldb' ? (p.replicas ?? 0) === 0 : p.instances < 2
    if (single) {
      recs.push({
        severity: 'warning', node: n.id, title: `${name}: единая точка отказа (SPOF)`,
        detail: n.kind === 'sqldb' ? 'Нет реплик: при падении primary данные недоступны. Добавьте хотя бы одну реплику для failover.' : 'Один инстанс — его падение кладёт всю цепочку. Запустите минимум 2 за балансировщиком.',
      })
    } else if (p.azCount < 2) {
      recs.push({ severity: 'info', node: n.id, title: `${name}: все инстансы в одной AZ`, detail: 'Разнесите инстансы минимум по 2–3 зонам доступности, чтобы пережить отказ дата-центра.' })
    }
  }
  const multi = graph.nodes.filter((n) => ['webserver', 'microservice', 'gateway'].includes(n.kind) && n.params.instances > 1)
  for (const n of multi) {
    if (!inc(n.id).some((s) => s && ['loadbalancer', 'gateway'].includes(s.kind)) && n.kind !== 'gateway' && inc(n.id).some((s) => s?.kind === 'client' || s?.kind === 'dns')) {
      recs.push({ severity: 'info', node: n.id, title: `«${n.label}»: нет балансировщика`, detail: 'Несколько инстансов без LB — клиенты не распределятся. Добавьте Load Balancer.' })
    }
  }
  const hasPublic = graph.nodes.some((n) => n.kind === 'client')
  if (hasPublic && !kinds.has('ratelimiter')) {
    recs.push({ severity: 'info', title: 'Нет rate limiting', detail: 'Публичный API без ограничения — всплеск или бот может положить систему. Добавьте Rate Limiter на входе (на gateway/LB).' })
  }
  const sql = graph.nodes.filter((n) => n.kind === 'sqldb' || n.kind === 'nosql')
  if (sql.length && !kinds.has('cache') && !kinds.has('semcache')) {
    recs.push({ severity: 'info', title: 'Нет кэша', detail: 'Все чтения идут в базу. Redis перед БД обычно снимает 70–95% чтений и сильно снижает p99.' })
  }
  if (!kinds.has('cdn') && graph.nodes.some((n) => n.kind === 'objectstorage' || n.kind === 'webserver')) {
    recs.push({ severity: 'info', title: 'Нет CDN', detail: 'Статика и медиа без CDN — лишняя латентность для пользователей и нагрузка на origin.' })
  }
  for (const n of graph.nodes.filter((x) => x.kind === 'cache' || x.kind === 'cdn')) {
    if ((n.params.hitRatio ?? 0) < 60) recs.push({ severity: 'warning', node: n.id, title: `«${n.label}»: низкий hit ratio (${n.params.hitRatio}%)`, detail: 'Кэш почти не помогает. Проверьте TTL, размер (RAM), ключи кэширования и прогрев.' })
  }
  for (const n of graph.nodes.filter((x) => x.kind === 'external' || x.kind === 'llm')) {
    if (n.params.failureRate >= 0.5) recs.push({ severity: 'info', node: n.id, title: `«${n.label}»: нестабильная зависимость (${n.params.failureRate}% ошибок)`, detail: 'Добавьте ретраи с exponential backoff, circuit breaker и fallback (деградация функционала).' })
  }

  const rawById = new Map(rawGraph.nodes.map((n) => [n.id, n]))
  recs.push(...aiRecommendations({ nodes: graph.nodes.map((n) => ({ ...n, params: { ...rawById.get(n.id)!.params } })), edges: graph.edges }, peaks))

  if (res && slo) {
    const s = res.summary
    if (res.scenario.id === 'stress' && s.breakingRps) {
      recs.unshift({ severity: s.breakingRps < res.baseRps * 1.5 ? 'critical' : 'info', title: `Точка отказа: ~${Math.round(s.breakingRps).toLocaleString('ru')} RPS`, detail: `Это ×${(s.breakingRps / Math.max(1, res.baseRps)).toFixed(1)} от целевой нагрузки. Рекомендуемый запас — не меньше ×2.` })
    }
    if (['failover', 'az', 'cache', 'db'].includes(res.scenario.id) && s.maxErrorPct > slo.errorPct) {
      recs.unshift({ severity: 'critical', title: 'Система не пережила аварию', detail: `Ошибки во время инцидента доходили до ${s.maxErrorPct.toFixed(1)}%. ${s.recoverySec !== undefined ? `Восстановление заняло ${s.recoverySec} с.` : 'Система не восстановилась до конца теста.'} Нужна избыточность: N+1 инстансов, несколько AZ, реплики БД и автоматический failover.` })
    }
  }
  const order = { critical: 0, warning: 1, info: 2 }
  return recs.sort((a, b) => order[a.severity] - order[b.severity])
}

export function reportMarkdown(graph: SimGraph, r: ScenarioResult, slo: Slo): string {
  const s = r.summary
  const lines = [
    `# Отчёт: ${r.scenario.title}`,
    '',
    `Цель: ${r.scenario.goal}`,
    '',
    `- Целевая нагрузка: **${r.baseRps.toLocaleString('ru')} RPS** (${(r.baseRps * 60).toLocaleString('ru')} RPM)`,
    `- SLO: p99 ≤ ${slo.p99Ms} мс, ошибки ≤ ${slo.errorPct}%`,
    `- Итог: **${s.passed ? 'ПРОЙДЕН ✅' : 'НЕ ПРОЙДЕН ❌'}** ${s.sloViolations.join('; ')}`,
    `- Макс. p99: ${Math.round(s.maxP99)} мс, средний p99: ${Math.round(s.avgP99)} мс`,
    `- Макс. ошибки: ${s.maxErrorPct.toFixed(2)}%, средние: ${s.avgErrorPct.toFixed(2)}%`,
    `- Пиковая пропускная способность: ${Math.round(s.peakThroughput).toLocaleString('ru')} RPS`,
    s.breakingRps ? `- Точка отказа: ~${Math.round(s.breakingRps).toLocaleString('ru')} RPS` : '',
    s.recoverySec !== undefined ? `- Время восстановления: ${s.recoverySec} с` : '',
    `- Стоимость: ~$${Math.round(s.avgCostMonth).toLocaleString('ru')}/мес`,
    '',
    '## Узлы (пиковые значения)',
    '',
    '| Узел | Тип | Пик загрузки | Пик RPS | Потери | Lag |',
    '|---|---|---|---|---|---|',
    ...r.peaks.filter((p) => p.kind !== 'client').sort((a, b) => b.peakUtil - a.peakUtil).map((p) =>
      `| ${p.label} | ${CATALOG[p.kind as keyof typeof CATALOG]?.short ?? p.kind} | ${Math.round(p.peakUtil * 100)}% | ${Math.round(p.peakArrivals)} | ${p.maxDropPct.toFixed(1)}% | ${p.maxLagSec > 1e8 ? '∞' : Math.round(p.maxLagSec) + ' с'} |`),
    '',
    '## Рекомендации',
    '',
    ...r.recommendations.map((x) => `- **[${x.severity === 'critical' ? 'Критично' : x.severity === 'warning' ? 'Важно' : 'Совет'}] ${x.title}.** ${x.detail}`),
    '',
    `_Архитектура: ${graph.nodes.length} компонентов, ${graph.edges.length} связей. Сгенерировано Arch Sim._`,
  ]
  return lines.filter((l) => l !== '').join('\n').replace(/\n(#+ )/g, '\n\n$1').replace(/(\n## [^\n]+)\n/g, '$1\n\n')
}
