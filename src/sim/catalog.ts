import type { Kind, Params, EdgeData } from './types'

export type Category = 'Вход' | 'Сеть' | 'Вычисления' | 'Данные' | 'Асинхронность' | 'Внешнее и AI'

export interface KindDef {
  kind: Kind
  title: string
  short: string
  category: Category
  color: string
  description: string
  defaults: Params
  fields: (keyof Params)[]
  /** режим исходящих рёбер по умолчанию */
  edgeMode: 'route' | 'call'
}

const base = (p: Partial<Params>): Params => ({
  instances: 1,
  cpu: 2,
  ramGb: 4,
  maxRps: 500,
  latencyMs: 10,
  failureRate: 0,
  costPerHour: 0.1,
  region: 'eu-central',
  azCount: 1,
  autoscale: false,
  maxInstances: 10,
  ...p,
})

const COMMON: (keyof Params)[] = ['instances', 'cpu', 'ramGb', 'maxRps', 'latencyMs', 'failureRate', 'costPerHour', 'region', 'azCount', 'autoscale', 'maxInstances']
const MANAGED: (keyof Params)[] = ['maxRps', 'latencyMs', 'failureRate', 'costPerHour', 'costPer1kReq', 'region']

export const CATALOG: Record<Kind, KindDef> = {
  client: {
    kind: 'client', title: 'Клиенты / Users', short: 'Client', category: 'Вход', color: '#60a5fa', edgeMode: 'route',
    description: 'Источник трафика. Нагрузка задаётся внизу (RPS/RPM). Если клиентов несколько — делят трафик по «доле».',
    defaults: base({ maxRps: 1e9, latencyMs: 0, costPerHour: 0, trafficShare: 100 }),
    fields: ['trafficShare', 'region'],
  },
  dns: {
    kind: 'dns', title: 'DNS', short: 'DNS', category: 'Сеть', color: '#a78bfa', edgeMode: 'route',
    description: 'Резолвит домен и распределяет трафик (GeoDNS / failover). Кэшируется клиентами, почти не добавляет задержки.',
    defaults: base({ maxRps: 1e7, latencyMs: 2, costPerHour: 0.001, costPer1kReq: 0.0004, azCount: 3 }),
    fields: MANAGED,
  },
  cdn: {
    kind: 'cdn', title: 'CDN', short: 'CDN', category: 'Сеть', color: '#f472b6', edgeMode: 'route',
    description: 'Отдаёт статику и кэшируемые ответы с edge-серверов. Hit ratio — доля чтений, обслуженных без похода в origin.',
    defaults: base({ maxRps: 1e6, latencyMs: 15, hitRatio: 85, costPerHour: 0, costPer1kReq: 0.001, azCount: 3 }),
    fields: ['hitRatio', ...MANAGED],
  },
  loadbalancer: {
    kind: 'loadbalancer', title: 'Load Balancer', short: 'LB', category: 'Сеть', color: '#34d399', edgeMode: 'route',
    description: 'Балансировщик L4/L7. Распределяет запросы между здоровыми бэкендами: round-robin, least-connections, weighted.',
    defaults: base({ maxRps: 50000, latencyMs: 1, costPerHour: 0.025, layer: 'L7', algorithm: 'round-robin', azCount: 2, instances: 2 }),
    fields: ['layer', 'algorithm', ...COMMON],
  },
  gateway: {
    kind: 'gateway', title: 'API Gateway', short: 'API GW', category: 'Сеть', color: '#22d3ee', edgeMode: 'route',
    description: 'Единая точка входа для API: маршрутизация по сервисам, TLS, auth-проверки, квоты.',
    defaults: base({ maxRps: 10000, latencyMs: 5, costPerHour: 0.05, instances: 2, azCount: 2 }),
    fields: COMMON,
  },
  ratelimiter: {
    kind: 'ratelimiter', title: 'Rate Limiter', short: 'RL', category: 'Сеть', color: '#fbbf24', edgeMode: 'route',
    description: 'Ограничивает входящий поток (token bucket). Лишние запросы отклоняются 429 и не роняют систему.',
    defaults: base({ maxRps: 100000, latencyMs: 1, costPerHour: 0.02, limitRps: 5000 }),
    fields: ['limitRps', ...COMMON],
  },
  auth: {
    kind: 'auth', title: 'Auth Service', short: 'Auth', category: 'Вычисления', color: '#fb923c', edgeMode: 'call',
    description: 'Аутентификация и авторизация (JWT/OAuth2). Обычно вызывается на каждый запрос — кандидат в бутылочное горло.',
    defaults: base({ maxRps: 2000, latencyMs: 8, costPerHour: 0.08, instances: 2 }),
    fields: COMMON,
  },
  webserver: {
    kind: 'webserver', title: 'Web / App Server', short: 'App', category: 'Вычисления', color: '#4ade80', edgeMode: 'call',
    description: 'Stateless-сервер приложения. Масштабируется горизонтально за балансировщиком.',
    defaults: base({ maxRps: 800, latencyMs: 20, cpu: 4, ramGb: 8, costPerHour: 0.17, instances: 2, maxInstances: 20 }),
    fields: COMMON,
  },
  microservice: {
    kind: 'microservice', title: 'Microservice', short: 'Svc', category: 'Вычисления', color: '#86efac', edgeMode: 'call',
    description: 'Отдельный сервис со своей зоной ответственности и своими зависимостями.',
    defaults: base({ maxRps: 600, latencyMs: 15, costPerHour: 0.1, instances: 2 }),
    fields: COMMON,
  },
  cache: {
    kind: 'cache', title: 'Cache (Redis/Memcached)', short: 'Cache', category: 'Данные', color: '#ef4444', edgeMode: 'route',
    description: 'In-memory кэш. Промахи (miss) уходят дальше — в БД. Падение кэша = вся нагрузка на БД (thundering herd).',
    defaults: base({ maxRps: 50000, latencyMs: 1, ramGb: 16, costPerHour: 0.22, hitRatio: 80, engine: 'Redis' }),
    fields: ['engine', 'hitRatio', ...COMMON],
  },
  sqldb: {
    kind: 'sqldb', title: 'SQL DB', short: 'SQL', category: 'Данные', color: '#3b82f6', edgeMode: 'call',
    description: 'Реляционная БД. Запись идёт в primary, чтение — в read-реплики. Шардирование умножает ёмкость. При падении primary — failover.',
    defaults: base({ maxRps: 1500, latencyMs: 5, cpu: 8, ramGb: 32, costPerHour: 0.5, replicas: 0, shards: 1, failoverSec: 30, engine: 'PostgreSQL', maxInstances: 1 }),
    fields: ['engine', 'replicas', 'shards', 'failoverSec', 'cpu', 'ramGb', 'maxRps', 'latencyMs', 'failureRate', 'costPerHour', 'region', 'azCount'],
  },
  nosql: {
    kind: 'nosql', title: 'NoSQL DB', short: 'NoSQL', category: 'Данные', color: '#8b5cf6', edgeMode: 'call',
    description: 'Распределённая NoSQL (Cassandra, MongoDB, DynamoDB). Линейно масштабируется узлами.',
    defaults: base({ maxRps: 3000, latencyMs: 4, cpu: 8, ramGb: 32, costPerHour: 0.4, instances: 3, azCount: 3, engine: 'Cassandra' }),
    fields: ['engine', ...COMMON],
  },
  queue: {
    kind: 'queue', title: 'Message Queue / Kafka', short: 'Queue', category: 'Асинхронность', color: '#f59e0b', edgeMode: 'route',
    description: 'Брокер сообщений. Отвечает продюсеру сразу, а воркеры разбирают очередь асинхронно. Если воркеры не успевают — растёт lag.',
    defaults: base({ maxRps: 20000, latencyMs: 3, costPerHour: 0.2, instances: 3, azCount: 3, engine: 'Kafka', partitions: 12 }),
    fields: ['engine', 'partitions', ...COMMON],
  },
  worker: {
    kind: 'worker', title: 'Worker', short: 'Worker', category: 'Асинхронность', color: '#fcd34d', edgeMode: 'call',
    description: 'Фоновые обработчики: читают очередь, делают тяжёлую работу (рассылки, транскодинг, индексация).',
    defaults: base({ maxRps: 200, latencyMs: 50, costPerHour: 0.1, instances: 2, maxInstances: 30 }),
    fields: COMMON,
  },
  objectstorage: {
    kind: 'objectstorage', title: 'Object Storage (S3)', short: 'S3', category: 'Данные', color: '#10b981', edgeMode: 'call',
    description: 'Объектное хранилище для файлов, медиа и бэкапов. Практически безлимитно, платится за запросы и объём.',
    defaults: base({ maxRps: 5500, latencyMs: 30, costPerHour: 0.03, costPer1kReq: 0.0004, azCount: 3 }),
    fields: MANAGED,
  },
  search: {
    kind: 'search', title: 'Search (Elasticsearch)', short: 'Search', category: 'Данные', color: '#eab308', edgeMode: 'call',
    description: 'Полнотекстовый / векторный поиск. Индексация обычно асинхронная через очередь.',
    defaults: base({ maxRps: 1000, latencyMs: 25, cpu: 8, ramGb: 32, costPerHour: 0.45, instances: 3, azCount: 3 }),
    fields: COMMON,
  },
  external: {
    kind: 'external', title: 'External API', short: 'Ext API', category: 'Внешнее и AI', color: '#94a3b8', edgeMode: 'call',
    description: 'Сторонний API (платежи, SMS, карты). Имеет лимиты и может падать — нужен circuit breaker и таймауты.',
    defaults: base({ maxRps: 300, latencyMs: 150, failureRate: 0.5, costPerHour: 0, costPer1kReq: 0.5 }),
    fields: MANAGED,
  },
  llm: {
    kind: 'llm', title: 'LLM / AI Inference', short: 'LLM', category: 'Внешнее и AI', color: '#e879f9', edgeMode: 'call',
    description: 'Инференс модели на GPU или через API. Высокая латентность и цена, низкий RPS на инстанс — классическое горлышко.',
    defaults: base({ maxRps: 8, latencyMs: 1200, cpu: 16, ramGb: 96, costPerHour: 2.5, instances: 2, maxInstances: 16, costPer1kReq: 0, model: 'Llama-3-70B (GPU A100)' }),
    fields: ['model', ...COMMON, 'costPer1kReq'],
  },
}

export const KINDS = Object.keys(CATALOG) as Kind[]

export interface FieldDef {
  label: string
  unit?: string
  type: 'number' | 'select' | 'bool' | 'text'
  min?: number
  max?: number
  step?: number
  options?: string[]
  hint?: string
}

export const FIELD_DEFS: Record<keyof Params, FieldDef> = {
  instances: { label: 'Инстансы', type: 'number', min: 1, max: 1000, step: 1, hint: 'Сколько копий сервиса запущено' },
  cpu: { label: 'CPU', unit: 'vCPU', type: 'number', min: 1, max: 256, step: 1, hint: 'При изменении пропорционально меняются RPS и цена' },
  ramGb: { label: 'RAM', unit: 'GB', type: 'number', min: 1, max: 2048, step: 1 },
  maxRps: { label: 'Макс. RPS на инстанс', unit: 'rps', type: 'number', min: 1, step: 50, hint: 'Пропускная способность одного инстанса (μ)' },
  latencyMs: { label: 'Латентность обработки', unit: 'мс', type: 'number', min: 0, step: 1 },
  failureRate: { label: 'Доля ошибок', unit: '%', type: 'number', min: 0, max: 100, step: 0.1 },
  costPerHour: { label: 'Цена за инстанс', unit: '$/час', type: 'number', min: 0, step: 0.01 },
  costPer1kReq: { label: 'Цена за 1000 запросов', unit: '$', type: 'number', min: 0, step: 0.0001 },
  region: { label: 'Регион', type: 'select', options: ['ru-moscow', 'eu-central', 'us-east', 'asia-east'], hint: 'Межрегиональный вызов добавляет ~70 мс' },
  azCount: { label: 'Зоны доступности (AZ)', type: 'number', min: 1, max: 3, step: 1, hint: 'Инстансы разнесены по AZ. 1 AZ = падение зоны кладёт узел' },
  autoscale: { label: 'Autoscaling', type: 'bool', hint: 'Добавлять инстансы при загрузке > 70%' },
  maxInstances: { label: 'Макс. инстансов (autoscale)', type: 'number', min: 1, max: 1000, step: 1 },
  hitRatio: { label: 'Cache hit ratio', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  trafficShare: { label: 'Доля трафика', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  algorithm: { label: 'Алгоритм', type: 'select', options: ['round-robin', 'least-conn', 'weighted'], hint: 'least-conn направляет больше на более мощные бэкенды' },
  layer: { label: 'Уровень', type: 'select', options: ['L4', 'L7'], hint: 'L4 — TCP, быстрее; L7 — HTTP, умеет маршрутизацию по пути' },
  engine: { label: 'Движок', type: 'text' },
  replicas: { label: 'Read-реплики', type: 'number', min: 0, max: 15, step: 1, hint: 'Чтения уходят на реплики, запись — только в primary' },
  shards: { label: 'Шарды', type: 'number', min: 1, max: 256, step: 1, hint: 'Каждый шард — свой primary (+реплики)' },
  failoverSec: { label: 'Время failover', unit: 'сек', type: 'number', min: 0, max: 600, step: 1, hint: 'Сколько длится промоут реплики при падении primary' },
  limitRps: { label: 'Лимит', unit: 'rps', type: 'number', min: 1, step: 100 },
  partitions: { label: 'Партиции', type: 'number', min: 1, max: 1000, step: 1, hint: 'Максимум параллельных консьюмеров' },
  model: { label: 'Модель', type: 'text' },
}

export function defaultEdgeData(sourceKind: Kind, targetKind?: Kind): EdgeData {
  const def = CATALOG[sourceKind]
  const isQueue = sourceKind === 'queue'
  // в очередь обычно пишут
  const filter = targetKind === 'queue' ? 'write' : 'all'
  return { mode: isQueue ? 'route' : def.edgeMode, weight: 1, filter, async: isQueue }
}

export function regionLatency(a: string, b: string): number {
  if (a === b) return 0
  const pair = [a, b].sort().join('|')
  const table: Record<string, number> = {
    'eu-central|ru-moscow': 35,
    'eu-central|us-east': 90,
    'ru-moscow|us-east': 120,
    'asia-east|eu-central': 160,
    'asia-east|ru-moscow': 130,
    'asia-east|us-east': 180,
  }
  return table[pair] ?? 70
}
