import { deriveNode } from './ai'
import { initialState, patternRps, simulateTick } from './engine'
import type { Kind, SimGraph } from './types'

export type CostProfile = 'peak' | 'wave' | 'business'

const waveAvg = (() => {
  let s = 0
  for (let i = 0; i < 1000; i++) s += patternRps('wave', 1, (i + 0.5) * 0.12, 120)
  return s / 1000
})()

/** Отношение среднего трафика за месяц к пиковому */
export const COST_PROFILES: Record<CostProfile, { label: string; ratio: number; hint: string }> = {
  peak: { label: 'Пик 24/7', ratio: 1, hint: 'Пиковая нагрузка круглосуточно — верхняя оценка' },
  wave: { label: 'Суточная волна', ratio: waveAvg, hint: `Ночью ~20% пика, вечером 100%: средний ≈ ${Math.round(waveAvg * 100)}% пика` },
  business: { label: 'Рабочие часы (B2B)', ratio: 0.3, hint: 'Нагрузка в будни днём, ночью и в выходные почти ноль: средний ≈ 30% пика' },
}

export interface NodeCost {
  id: string
  label: string
  kind: Kind
  fixed: number // инстансы × $/час × 730
  variable: number // запросы / токены
  total: number
  instances: number
  avgRps: number
}

export interface CostEstimate {
  profile: CostProfile
  ratio: number
  peakRps: number
  avgRps: number
  total: number
  totalAtPeak: number
  fixed: number
  variable: number
  nodes: NodeCost[]
  perMillionRequests: number
}

const HOURS = 730
const SECONDS = 730 * 3600

/**
 * Месячная стоимость при среднем трафике: переменная часть (токены, запросы) — по среднему RPS,
 * узлы с autoscaling — по числу инстансов, нужному для среднего трафика (не ниже минимума),
 * остальные — по фиксированному числу инстансов.
 */
export function estimateCost(graph: SimGraph, peakRps: number, readRatio: number, profile: CostProfile = 'wave'): CostEstimate {
  const ratio = COST_PROFILES[profile].ratio
  const avgRps = peakRps * ratio
  const at = (rps: number) => {
    const res = simulateTick(graph, { rps, readRatio }, initialState(), {}, { samples: 0, steadyAutoscale: true })
    const nodes: NodeCost[] = graph.nodes.filter((n) => n.kind !== 'client').map((raw) => {
      const n = deriveNode(raw)
      const p = n.params
      const m = res.nodes[n.id]
      const served = m?.served ?? 0
      let instances: number
      if (n.kind === 'sqldb') instances = Math.max(1, p.shards ?? 1) * (1 + Math.max(0, p.replicas ?? 0))
      else instances = Math.max(p.instances, m?.instances ?? p.instances)
      const fixed = instances * p.costPerHour * HOURS
      const variable = ((p.costPer1kReq ?? 0) * served * SECONDS) / 1000
      return { id: n.id, label: n.label, kind: n.kind, fixed, variable, total: fixed + variable, instances, avgRps: m?.arrivals ?? 0 }
    })
    return nodes
  }
  const nodes = at(avgRps).sort((a, b) => b.total - a.total)
  const peakNodes = ratio === 1 ? nodes : at(peakRps)
  const total = nodes.reduce((s, n) => s + n.total, 0)
  const monthlyReq = avgRps * SECONDS
  return {
    profile, ratio, peakRps, avgRps, total,
    totalAtPeak: peakNodes.reduce((s, n) => s + n.total, 0),
    fixed: nodes.reduce((s, n) => s + n.fixed, 0),
    variable: nodes.reduce((s, n) => s + n.variable, 0),
    nodes,
    perMillionRequests: monthlyReq > 0 ? (total / monthlyReq) * 1e6 : 0,
  }
}
