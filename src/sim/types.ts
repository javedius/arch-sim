export type Kind =
  | 'client' | 'dns' | 'cdn' | 'loadbalancer' | 'gateway' | 'ratelimiter' | 'auth'
  | 'webserver' | 'microservice' | 'cache' | 'sqldb' | 'nosql' | 'queue' | 'worker'
  | 'objectstorage' | 'search' | 'external' | 'llm'
  | 'llmapi' | 'gpullm' | 'embedding' | 'vectordb' | 'ragorch' | 'agent' | 'mcp' | 'semcache' | 'guardrails'

export type Region = 'ru-moscow' | 'eu-central' | 'us-east' | 'asia-east'

export interface Params {
  instances: number
  cpu: number
  ramGb: number
  maxRps: number // на один инстанс
  latencyMs: number
  failureRate: number // %
  costPerHour: number // $ за инстанс в час
  costPer1kReq?: number // $ за 1000 запросов
  region: Region
  azCount: number
  autoscale?: boolean
  maxInstances?: number
  // специфичные
  hitRatio?: number // %
  trafficShare?: number // % для клиента
  algorithm?: 'round-robin' | 'least-conn' | 'weighted'
  layer?: 'L4' | 'L7'
  engine?: string
  replicas?: number
  shards?: number
  failoverSec?: number
  limitRps?: number
  partitions?: number
  model?: string
  // AI / токены
  inTokens?: number // входных токенов на запрос
  outTokens?: number // выходных токенов на запрос
  tokensPerSec?: number // скорость генерации на один поток (decode)
  ttftMs?: number // time to first token (база)
  costPer1MIn?: number // $ за 1M входных токенов
  costPer1MOut?: number // $ за 1M выходных токенов
  tpmLimit?: number // лимит токенов в минуту
  gpuType?: string
  batchSize?: number
  throughputTps?: number // токенов/с на инстанс (эмбеддинги)
  recall?: number // % recall@k
  indexM?: number // размер индекса, млн векторов
  steps?: number // шагов агента на запрос
  blockRate?: number // % заблокированных запросов
  cachedInputPct?: number // % входных токенов из prompt cache
  cacheDiscount?: number // скидка на кэшированные входные токены, %
}

export type EdgeMode = 'route' | 'call'
export type EdgeFilter = 'all' | 'read' | 'write'

export interface EdgeData {
  mode: EdgeMode // route — распределить трафик, call — вызов на каждый запрос
  weight: number // для route — вес, для call — вызовов на запрос
  filter: EdgeFilter
  async: boolean
  [k: string]: unknown
}

export interface SimNode {
  id: string
  kind: Kind
  label: string
  params: Params
}

export interface SimEdge {
  id: string
  source: string
  target: string
  data: EdgeData
}

export interface SimGraph {
  nodes: SimNode[]
  edges: SimEdge[]
}

export interface NodeFault {
  down?: boolean // узел полностью недоступен
  lostInstances?: number // потеряно инстансов (AZ)
  primaryDownSince?: number // секунда симуляции, когда упал primary БД
}
export type Faults = Record<string, NodeFault>

export interface SimState {
  t: number
  backlog: Record<string, number>
  instances: Record<string, number> // autoscale
  lastScale: Record<string, number>
  seed: number
}

export interface NodeMetrics {
  arrivals: number
  reads: number
  writes: number
  served: number
  dropped: number
  rejected: number
  errors: number
  utilization: number
  latencyMs: number // средняя собственная латентность
  instances: number
  capacity: number
  costMonth: number
  backlog?: number
  lagSec?: number
  hits?: number
  status: 'idle' | 'ok' | 'warn' | 'hot' | 'down'
}

export interface GlobalMetrics {
  offered: number
  throughput: number
  errorRate: number // доля 0..1
  rejectedRate: number
  p50: number
  p95: number
  p99: number
  avg: number
  costMonth: number
  bottleneck?: string
  maxUtil: number
}

export interface TickResult {
  nodes: Record<string, NodeMetrics>
  edges: Record<string, number>
  global: GlobalMetrics
  state: SimState
  warnings: string[]
}

export interface LoadInput {
  rps: number
  readRatio: number // 0..1
}
