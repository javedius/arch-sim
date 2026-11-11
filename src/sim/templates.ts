import { CATALOG, defaultEdgeData } from './catalog'
import type { EdgeData, Kind, Params, SimEdge, SimGraph, SimNode } from './types'

export interface Template {
  id: string
  title: string
  description: string
  rps: number
  readRatio: number
  slo?: { p99Ms: number; errorPct: number }
  graph: SimGraph
}

function build(spec: {
  nodes: [string, Kind, string, Partial<Params>?][]
  edges: [string, string, Partial<EdgeData>?][]
}): SimGraph {
  const nodes: SimNode[] = spec.nodes.map(([id, kind, label, p]) => ({ id, kind, label, params: { ...CATALOG[kind].defaults, ...(p ?? {}) } }))
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]))
  const edges: SimEdge[] = spec.edges.map(([s, t, d], i) => ({
    id: `e${i}_${s}_${t}`, source: s, target: t, data: { ...defaultEdgeData(kindOf.get(s)!, kindOf.get(t)), ...(d ?? {}) },
  }))
  return { nodes, edges }
}

export const TEMPLATES: Template[] = [
  {
    id: 'three-tier', title: 'Классика: 3-tier', rps: 1000, readRatio: 0.8,
    description: 'Клиент → LB → серверы приложения → кэш → PostgreSQL с репликой. Отправная точка для экспериментов.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['lb', 'loadbalancer', 'ALB'],
        ['app', 'webserver', 'App Server', { instances: 3, azCount: 2 }],
        ['redis', 'cache', 'Redis', { azCount: 2 }],
        ['pg', 'sqldb', 'PostgreSQL', { replicas: 1, azCount: 2 }],
      ],
      edges: [['users', 'lb'], ['lb', 'app'], ['app', 'redis', { filter: 'read' }], ['redis', 'pg'], ['app', 'pg', { filter: 'write' }]],
    }),
  },
  {
    id: 'url-shortener', title: 'URL Shortener (bit.ly)', rps: 5000, readRatio: 0.95,
    description: 'Чтения в ~100 раз чаще записи. Редиректы кэшируются в CDN и Redis, генерация ID — отдельный сервис, аналитика кликов — асинхронно через Kafka.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['dns', 'dns', 'DNS'],
        ['cdn', 'cdn', 'CDN (редиректы)', { hitRatio: 60 }],
        ['lb', 'loadbalancer', 'Load Balancer'],
        ['rl', 'ratelimiter', 'Rate Limiter', { limitRps: 20000, instances: 2, azCount: 2 }],
        ['api', 'webserver', 'Shortener API', { instances: 4, azCount: 2, autoscale: true }],
        ['idgen', 'microservice', 'ID Generator (Snowflake)', { latencyMs: 2, maxRps: 5000 }],
        ['redis', 'cache', 'Redis', { hitRatio: 90, instances: 2, azCount: 2 }],
        ['db', 'nosql', 'Cassandra (urls)'],
        ['kafka', 'queue', 'Kafka (клики)'],
        ['an', 'worker', 'Analytics Worker', { maxRps: 2000 }],
        ['ch', 'nosql', 'ClickHouse', { engine: 'ClickHouse', maxRps: 20000 }],
      ],
      edges: [
        ['users', 'dns'], ['dns', 'cdn'], ['cdn', 'lb'], ['lb', 'rl'], ['rl', 'api'],
        ['api', 'redis', { filter: 'read' }], ['redis', 'db'],
        ['api', 'idgen', { filter: 'write' }], ['api', 'db', { filter: 'write' }],
        ['api', 'kafka', { filter: 'all' }], ['kafka', 'an'], ['an', 'ch'],
      ],
    }),
  },
  {
    id: 'twitter', title: 'Twitter / лента новостей', rps: 20000, readRatio: 0.9,
    description: 'Fan-out on write: новый твит через Kafka раскладывается воркерами по лентам подписчиков в Redis. Чтение ленты — из кэша.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['dns', 'dns', 'DNS'],
        ['cdn', 'cdn', 'CDN (медиа)', { hitRatio: 50 }],
        ['lb', 'loadbalancer', 'Load Balancer', { instances: 3, azCount: 3 }],
        ['gw', 'gateway', 'API Gateway', { instances: 6, azCount: 3 }],
        ['auth', 'auth', 'Auth (JWT)', { instances: 8, maxRps: 3000, azCount: 3 }],
        ['tl', 'microservice', 'Timeline Service', { instances: 12, maxRps: 1500, azCount: 3, autoscale: true, maxInstances: 40 }],
        ['tw', 'microservice', 'Tweet Service', { instances: 4, azCount: 3 }],
        ['redis', 'cache', 'Redis (ленты)', { hitRatio: 95, instances: 6, azCount: 3 }],
        ['cass', 'nosql', 'Cassandra (твиты)', { instances: 6 }],
        ['kafka', 'queue', 'Kafka (fan-out)', { partitions: 48 }],
        ['fan', 'worker', 'Fan-out Workers', { instances: 10, maxRps: 500, maxInstances: 48, autoscale: true }],
        ['s3', 'objectstorage', 'S3 (медиа)'],
        ['es', 'search', 'Elasticsearch'],
      ],
      edges: [
        ['users', 'dns'], ['dns', 'cdn'], ['cdn', 's3', { filter: 'read', weight: 0.2 }], ['cdn', 'lb'],
        ['lb', 'gw'], ['gw', 'auth', { mode: 'call' }],
        ['gw', 'tl', { filter: 'read' }], ['gw', 'tw', { filter: 'write' }],
        ['tl', 'redis'], ['redis', 'cass'],
        ['tw', 'cass', { filter: 'write' }], ['tw', 'kafka'], ['kafka', 'fan'], ['fan', 'redis', { filter: 'write', weight: 5 }], ['fan', 'es', { filter: 'write' }],
      ],
    }),
  },
  {
    id: 'chat', title: 'Мессенджер / чат', rps: 8000, readRatio: 0.6,
    description: 'WebSocket-шлюзы за L4-балансировщиком (least-conn), сообщения через Kafka, хранение в Cassandra, онлайн-статусы в Redis, пуши во внешний сервис.',
    graph: build({
      nodes: [
        ['users', 'client', 'Мобильные клиенты'],
        ['lb', 'loadbalancer', 'L4 LB', { layer: 'L4', algorithm: 'least-conn', azCount: 2 }],
        ['ws', 'webserver', 'WebSocket Gateway', { instances: 6, maxRps: 2000, azCount: 2 }],
        ['auth', 'auth', 'Auth', { instances: 3, maxRps: 4000, azCount: 2 }],
        ['chat', 'microservice', 'Chat Service', { instances: 6, maxRps: 1500, azCount: 2 }],
        ['presence', 'cache', 'Redis (presence)', { hitRatio: 100, azCount: 2, instances: 2 }],
        ['kafka', 'queue', 'Kafka (сообщения)'],
        ['deliver', 'worker', 'Delivery Workers', { instances: 6, maxRps: 600 }],
        ['cass', 'nosql', 'Cassandra (история)', { instances: 4 }],
        ['push', 'external', 'Push (APNs/FCM)', { maxRps: 5000, latencyMs: 120 }],
      ],
      edges: [
        ['users', 'lb'], ['lb', 'ws'], ['ws', 'auth', { weight: 0.1 }], ['ws', 'chat'],
        ['chat', 'presence', { filter: 'read' }], ['chat', 'cass', { filter: 'read', weight: 0.3 }], ['chat', 'kafka'],
        ['kafka', 'deliver'], ['deliver', 'cass'], ['deliver', 'push', { weight: 0.3 }],
      ],
    }),
  },
  {
    id: 'video', title: 'Видеостриминг (YouTube)', rps: 30000, readRatio: 0.98,
    description: 'Видео отдаёт CDN (hit 95%), origin — S3. Загрузка видео уходит в очередь на транскодинг воркерами. Метаданные — PostgreSQL с репликами + Redis.',
    graph: build({
      nodes: [
        ['users', 'client', 'Зрители'],
        ['dns', 'dns', 'GeoDNS'],
        ['cdn', 'cdn', 'CDN (видео-сегменты)', { hitRatio: 95 }],
        ['s3', 'objectstorage', 'S3 (origin)', { maxRps: 10000 }],
        ['lb', 'loadbalancer', 'Load Balancer', { azCount: 3 }],
        ['api', 'webserver', 'Video API', { instances: 4, azCount: 3, autoscale: true }],
        ['redis', 'cache', 'Redis (метаданные)', { hitRatio: 90, instances: 2, azCount: 2 }],
        ['pg', 'sqldb', 'PostgreSQL', { replicas: 2, azCount: 3 }],
        ['q', 'queue', 'Очередь транскодинга', { engine: 'SQS', partitions: 64 }],
        ['tc', 'worker', 'Transcoder (FFmpeg)', { instances: 8, maxRps: 2, latencyMs: 30000, cpu: 16, costPerHour: 0.68, autoscale: true, maxInstances: 64 }],
      ],
      edges: [
        ['users', 'dns'], ['dns', 'cdn'], ['cdn', 's3', { filter: 'read', weight: 9 }], ['cdn', 'lb', { weight: 1 }],
        ['lb', 'api'], ['api', 'redis', { filter: 'read' }], ['redis', 'pg'], ['api', 'pg', { filter: 'write' }],
        ['api', 'q', { filter: 'write' }], ['q', 'tc'], ['tc', 's3', { weight: 4 }],
      ],
    }),
  },
  {
    id: 'rag', title: 'RAG / LLM-приложение', rps: 50, readRatio: 0.9, slo: { p99Ms: 6000, errorPct: 1 },
    description: 'AI-ассистент: gateway с rate limit, оркестратор, семантический кэш, векторный поиск, LLM на GPU. Индексация документов — асинхронно. Попробуйте поднять RPS — LLM станет горлышком.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['gw', 'gateway', 'API Gateway'],
        ['rl', 'ratelimiter', 'Rate Limiter (токены)', { limitRps: 200, instances: 2, azCount: 2 }],
        ['auth', 'auth', 'Auth'],
        ['orch', 'microservice', 'RAG Orchestrator', { instances: 3, maxRps: 200, latencyMs: 30, azCount: 2 }],
        ['sem', 'cache', 'Семантический кэш', { hitRatio: 30, engine: 'Redis + vectors' }],
        ['vec', 'search', 'Vector Search', { engine: 'Qdrant', latencyMs: 20 }],
        ['llm', 'llm', 'LLM Inference', { instances: 6, azCount: 2, autoscale: true }],
        ['emb', 'llm', 'Embeddings', { maxRps: 300, latencyMs: 15, costPerHour: 0.9, model: 'bge-m3', instances: 1 }],
        ['pg', 'sqldb', 'PostgreSQL (диалоги)', { replicas: 1, azCount: 2 }],
        ['q', 'queue', 'Очередь индексации'],
        ['ingest', 'worker', 'Ingest Worker'],
        ['s3', 'objectstorage', 'S3 (документы)'],
      ],
      edges: [
        ['users', 'gw'], ['gw', 'rl'], ['rl', 'orch'], ['gw', 'auth', { mode: 'call' }],
        ['orch', 'emb', { filter: 'read' }], ['orch', 'sem', { filter: 'read' }], ['sem', 'vec'], ['vec', 'llm', { mode: 'call', filter: 'read' }],
        ['orch', 'pg', { filter: 'all' }], ['orch', 'q', { filter: 'write' }], ['q', 'ingest'],
        ['ingest', 's3'], ['ingest', 'emb'], ['ingest', 'vec'],
      ],
    }),
  },
]
