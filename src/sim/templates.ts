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
        ['push', 'external', 'Push (APNs/FCM)', { maxRps: 5000, latencyMs: 120, costPer1kReq: 0 }],
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
    id: 'rag', title: 'RAG / LLM-приложение', rps: 10, readRatio: 0.9, slo: { p99Ms: 15000, errorPct: 1 },
    description: 'AI-ассистент по базе знаний: guardrails, семантический кэш, эмбеддинги, Vector DB, LLM API с оплатой за токены и TPM-лимитом, проверка ответа. Индексация документов — асинхронно.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['gw', 'gateway', 'API Gateway'],
        ['guard', 'guardrails', 'Guardrails (вход)'],
        ['rl', 'ratelimiter', 'Rate Limiter', { limitRps: 100, instances: 2, azCount: 2 }],
        ['orch', 'ragorch', 'RAG Orchestrator', { instances: 2 }],
        ['emb', 'embedding', 'Embeddings (запрос)', { inTokens: 60 }],
        ['sem', 'semcache', 'Семантический кэш', { hitRatio: 45 }],
        ['gen', 'ragorch', 'Генерация ответа', { autoscale: false }],
        ['vec', 'vectordb', 'Vector DB (Qdrant)', { indexM: 20, recall: 95 }],
        ['llm', 'llmapi', 'LLM API (gpt-5-mini)', { inTokens: 2500, outTokens: 300, cachedInputPct: 40, tpmLimit: 4_000_000 }],
        ['gout', 'guardrails', 'Guardrails (ответ)', { blockRate: 0.5, latencyMs: 40 }],
        ['pg', 'sqldb', 'PostgreSQL (диалоги)', { replicas: 1, azCount: 2 }],
        ['q', 'queue', 'Очередь индексации'],
        ['ingest', 'worker', 'Ingest Worker', { azCount: 2 }],
        ['embd', 'embedding', 'Embeddings (документы)', { inTokens: 4000, instances: 2 }],
        ['s3', 'objectstorage', 'S3 (документы)'],
      ],
      edges: [
        ['users', 'gw'], ['gw', 'guard'], ['guard', 'rl'], ['rl', 'orch'],
        ['orch', 'emb', { filter: 'read' }], ['orch', 'sem', { filter: 'read' }], ['sem', 'gen'],
        ['gen', 'vec'], ['gen', 'llm'], ['gen', 'gout'],
        ['orch', 'pg'], ['orch', 'q', { filter: 'write' }], ['q', 'ingest'],
        ['ingest', 's3'], ['ingest', 'embd'], ['ingest', 'vec'],
      ],
    }),
  },
  {
    id: 'multi-agent', title: 'Мультиагентная система + MCP', rps: 0.5, readRatio: 1, slo: { p99Ms: 180000, errorPct: 2 },
    description: 'Supervisor-агент делегирует задачи агентам-исследователю и кодеру. Агенты ходят в инструменты через MCP-серверы (веб-поиск, песочница кода, БД). Шаги агентов умножают вызовы LLM — посмотрите, как быстро растут токены и латентность.',
    graph: build({
      nodes: [
        ['users', 'client', 'Пользователи'],
        ['gw', 'gateway', 'API Gateway'],
        ['guard', 'guardrails', 'Guardrails', { blockRate: 1 }],
        ['sup', 'agent', 'Supervisor Agent', { steps: 2, instances: 2 }],
        ['sem', 'semcache', 'Семантический кэш', { hitRatio: 30 }],
        ['big', 'llmapi', 'LLM API (gpt-5, планировщик)', { model: 'gpt-5', inTokens: 2500, outTokens: 250, cachedInputPct: 70, costPer1MIn: 1.25, costPer1MOut: 10, tpmLimit: 2_000_000, failureRate: 0.1 }],
        ['res', 'agent', 'Research Agent', { steps: 4, instances: 2 }],
        ['code', 'agent', 'Coder Agent', { steps: 3, instances: 2 }],
        ['small', 'gpullm', 'Llama-3.1-8B (GPU)', { instances: 1, maxInstances: 6, inTokens: 2000, outTokens: 200, azCount: 1 }],
        ['mcps', 'mcp', 'MCP: web search'],
        ['web', 'external', 'Search API (Tavily)', { latencyMs: 800, maxRps: 50, costPer1kReq: 5, failureRate: 0.1 }],
        ['mem', 'vectordb', 'Память агентов (Vector DB)', { indexM: 2 }],
        ['mcpc', 'mcp', 'MCP: code sandbox'],
        ['box', 'worker', 'Code Sandbox', { latencyMs: 1500, maxRps: 1, instances: 3, azCount: 2, autoscale: true, maxInstances: 20, costPerHour: 0.05 }],
        ['mcpd', 'mcp', 'MCP: database'],
        ['pg', 'sqldb', 'PostgreSQL', { replicas: 1, azCount: 2 }],
      ],
      edges: [
        ['users', 'gw'], ['gw', 'guard'], ['guard', 'sup'],
        ['sup', 'sem'], ['sem', 'big'], ['sup', 'res', { weight: 0.6 }], ['sup', 'code', { weight: 0.3 }],
        ['res', 'small'], ['res', 'mcps', { weight: 0.5 }], ['mcps', 'web'], ['res', 'mem', { weight: 0.5 }],
        ['code', 'small'], ['code', 'mcpc'], ['mcpc', 'box'], ['code', 'mcpd', { weight: 0.5 }], ['mcpd', 'pg'],
      ],
    }),
  },
  {
    id: 'ai-support', title: 'AI-поддержка клиентов (scale)', rps: 200, readRatio: 0.85, slo: { p99Ms: 20000, errorPct: 1 },
    description: 'Чат поддержки на сотни RPS: база знаний в Vector DB, семантический кэш частых вопросов, агент-маршрутизатор: маленькая модель на своих GPU, сложное — эскалация в большую LLM API. Инструменты CRM и тикетов — через MCP.',
    graph: build({
      nodes: [
        ['users', 'client', 'Клиенты (чат)'],
        ['lb', 'loadbalancer', 'Load Balancer', { azCount: 3 }],
        ['gw', 'gateway', 'API Gateway', { instances: 3, azCount: 3 }],
        ['auth', 'auth', 'Auth', { azCount: 2 }],
        ['guard', 'guardrails', 'Guardrails / PII', { instances: 3, azCount: 3 }],
        ['orch', 'ragorch', 'Support Orchestrator', { instances: 2 }],
        ['emb', 'embedding', 'Embeddings', { inTokens: 100 }],
        ['kb', 'vectordb', 'База знаний (Vector DB)', { indexM: 5, instances: 3, azCount: 3 }],
        ['sem', 'semcache', 'Семантический кэш FAQ', { hitRatio: 50, instances: 3, azCount: 3 }],
        ['router', 'agent', 'Router Agent', { steps: 1, instances: 2, maxRps: 150 }],
        ['small', 'gpullm', 'Llama-3.1-8B (vLLM, H100)', { instances: 2, maxInstances: 12, inTokens: 1500, outTokens: 200, azCount: 2 }],
        ['big', 'llmapi', 'LLM API (gpt-5, эскалация)', { model: 'gpt-5', inTokens: 2500, outTokens: 200, cachedInputPct: 60, costPer1MIn: 1.25, costPer1MOut: 10, tpmLimit: 4_000_000 }],
        ['mcpcrm', 'mcp', 'MCP: CRM'],
        ['crm', 'sqldb', 'CRM (PostgreSQL)', { replicas: 2, azCount: 3 }],
        ['mcpt', 'mcp', 'MCP: тикеты'],
        ['zd', 'external', 'Zendesk API', { latencyMs: 250, maxRps: 300, costPer1kReq: 0 }],
        ['kafka', 'queue', 'Kafka (события)'],
        ['an', 'worker', 'Аналитика диалогов', { maxRps: 500, azCount: 2 }],
        ['ch', 'nosql', 'ClickHouse', { engine: 'ClickHouse', maxRps: 20000 }],
      ],
      edges: [
        ['users', 'lb'], ['lb', 'gw'], ['gw', 'auth', { mode: 'call' }], ['gw', 'guard'], ['guard', 'orch'],
        ['orch', 'emb', { filter: 'read' }], ['orch', 'kb', { filter: 'read' }], ['orch', 'sem', { filter: 'read' }], ['sem', 'router'],
        ['router', 'small'], ['router', 'big', { weight: 0.02 }], ['router', 'mcpcrm', { weight: 0.5 }], ['mcpcrm', 'crm'],
        ['router', 'mcpt', { weight: 0.2 }], ['mcpt', 'zd'],
        ['orch', 'kafka'], ['kafka', 'an'], ['an', 'ch'],
      ],
    }),
  },
]
