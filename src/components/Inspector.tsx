import { Copy, Power, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { tokenInfo } from '../sim/ai'
import { CATALOG, FIELD_DEFS } from '../sim/catalog'
import { recommend } from '../sim/scenarios'
import type { EdgeData, Params } from '../sim/types'
import { useStore } from '../store'
import { fmtMoney, fmtMs, fmtNum, fmtPct, STATUS_COLOR } from '../ui/format'
import { KIND_ICON } from '../ui/icons'

function Field({ k, value, onChange, onFocus }: { k: keyof Params; value: unknown; onChange: (v: unknown) => void; onFocus: () => void }) {
  const f = FIELD_DEFS[k]
  return (
    <label className="field" title={f.hint}>
      <span className="f-label">{f.label}{f.unit ? <i> {f.unit}</i> : null}</span>
      {f.type === 'number' && (
        <input type="number" value={Number(value ?? 0)} min={f.min} max={f.max} step={f.step ?? 'any'} onFocus={onFocus}
          onChange={(e) => {
            let v = Number(e.target.value)
            if (!Number.isFinite(v)) return
            if (f.min !== undefined) v = Math.max(f.min, v)
            if (f.max !== undefined) v = Math.min(f.max, v)
            onChange(v)
          }} />
      )}
      {f.type === 'select' && (
        <select value={String(value)} onFocus={onFocus} onChange={(e) => onChange(e.target.value)}>
          {f.options!.map((o) => <option key={o}>{o}</option>)}
        </select>
      )}
      {f.type === 'text' && <input type="text" value={String(value ?? '')} onFocus={onFocus} onChange={(e) => onChange(e.target.value)} />}
      {f.type === 'bool' && (
        <span className="switch">
          <input type="checkbox" checked={!!value} onChange={(e) => { onFocus(); onChange(e.target.checked) }} />
          <span>{value ? 'вкл' : 'выкл'}</span>
        </span>
      )}
    </label>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return <div className="metric"><span>{label}</span><b style={{ color }}>{value}</b></div>
}

export function Inspector() {
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const sel = nodes.find((n) => n.selected)
  const selEdge = !sel ? edges.find((e) => e.selected) : undefined
  if (sel) return <NodeInspector id={sel.id} />
  if (selEdge) return <EdgeInspector id={selEdge.id} />
  return <Overview />
}

function NodeInspector({ id }: { id: string }) {
  const n = useStore((s) => s.nodes.find((x) => x.id === id))!
  const m = useStore((s) => s.last?.nodes[id])
  const faulted = useStore((s) => !!s.faults[id]?.down)
  const { updateNode, checkpoint, duplicate, remove, toggleFault } = useStore.getState()
  const def = CATALOG[n.data.kind]
  const Icon = KIND_ICON[n.data.kind]
  const p = n.data.params
  return (
    <aside className="inspector">
      <div className="ins-head">
        <span className="pal-icon big" style={{ color: def.color, background: def.color + '22' }}><Icon size={22} /></span>
        <div>
          <input className="ins-name" value={n.data.label} onFocus={checkpoint} onChange={(e) => updateNode(id, { label: e.target.value })} />
          <div className="muted">{def.title}</div>
        </div>
      </div>
      <p className="desc">{def.description}</p>
      {m && n.data.kind !== 'client' && (
        <div className="metrics-grid">
          <Metric label="Вход" value={`${fmtNum(m.arrivals)} rps`} />
          <Metric label="Загрузка" value={fmtPct(m.utilization, 0)} color={STATUS_COLOR[faulted ? 'down' : m.status]} />
          <Metric label="Латентность" value={fmtMs(m.latencyMs)} />
          <Metric label="Ёмкость" value={`${fmtNum(m.capacity)} rps`} />
          <Metric label="Потери" value={`${fmtNum(m.dropped)} rps`} color={m.dropped > 0.5 ? '#ef4444' : undefined} />
          <Metric label="Ошибки" value={`${fmtNum(m.errors)} rps`} />
          {m.rejected > 0 && <Metric label="Отклонено 429" value={`${fmtNum(m.rejected)} rps`} color="#eab308" />}
          {m.hits !== undefined && m.hits > 0 && <Metric label="Cache hits" value={`${fmtNum(m.hits)} rps`} color="#22c55e" />}
          {m.backlog !== undefined && <Metric label="Backlog" value={`${fmtNum(m.backlog)} msg`} color={(m.lagSec ?? 0) > 5 ? '#ef4444' : undefined} />}
          {m.lagSec !== undefined && <Metric label="Lag" value={Number.isFinite(m.lagSec) ? fmtMs(m.lagSec * 1000) : '∞'} />}
          <Metric label="Инстансов" value={String(m.instances)} />
          <Metric label="Стоимость" value={`${fmtMoney(m.costMonth)}/мес`} />
        </div>
      )}
      <TokenPanel kind={n.data.kind} params={p} served={m?.served ?? 0} />
      <div className="ins-section">Параметры</div>
      <div className="fields">
        {def.fields.map((k) => (
          <Field key={k} k={k} value={p[k]} onFocus={checkpoint} onChange={(v) => updateNode(id, { [k]: v } as Partial<Params>)} />
        ))}
      </div>
      <div className="ins-actions">
        {n.data.kind !== 'client' && (
          <button className={faulted ? 'danger active' : 'danger'} onClick={() => toggleFault(id)} title="Симулировать отказ узла">
            <Power size={14} /> {faulted ? 'Поднять узел' : 'Убить узел'}
          </button>
        )}
        <button onClick={() => duplicate(id)}><Copy size={14} /> Дублировать</button>
        <button onClick={() => remove(id)}><Trash2 size={14} /> Удалить</button>
      </div>
    </aside>
  )
}

function TokenPanel({ kind, params, served }: { kind: import('../sim/types').Kind; params: Params; served: number }) {
  const info = tokenInfo(kind, params)
  if (!info) return null
  const tokPerMin = info.tokensPerReq ? served * info.tokensPerReq * 60 : 0
  return (
    <>
      <div className="ins-section">Расчёт по токенам</div>
      <div className="metrics-grid token">
        <Metric label="Время ответа" value={fmtMs(info.latencyMs)} />
        <Metric label={kind === 'llmapi' ? 'Ёмкость (TPM)' : 'Ёмкость реплики'} value={`${fmtNum(info.maxRps)} rps`} />
        {info.perStreamTps !== undefined && <Metric label="Скорость потока" value={`${fmtNum(info.perStreamTps)} ток/с`} />}
        {info.tokensPerReq !== undefined && <Metric label="Токенов / запрос" value={fmtNum(info.tokensPerReq)} />}
        {info.costPerReq > 0 && <Metric label="Цена запроса" value={`$${info.costPerReq.toFixed(5)}`} />}
        {info.costPerReq > 0 && <Metric label="Цена 1000 запросов" value={`$${(info.costPerReq * 1000).toFixed(2)}`} />}
        {tokPerMin > 0 && <Metric label="Токенов/мин сейчас" value={fmtNum(tokPerMin)} color={kind === 'llmapi' && params.tpmLimit && tokPerMin > params.tpmLimit * 0.85 ? '#ef4444' : undefined} />}
        {kind === 'gpullm' && <Metric label="Цена 1M ток. (при 100%)" value={`$${((params.costPerHour / 3600) / (info.maxRps * (info.tokensPerReq || 1)) * 1e6).toFixed(2)}`} />}
      </div>
    </>
  )
}

function EdgeInspector({ id }: { id: string }) {
  const e = useStore((s) => s.edges.find((x) => x.id === id))!
  const nodes = useStore((s) => s.nodes)
  const flow = useStore((s) => s.last?.edges[id] ?? 0)
  const { updateEdge, remove } = useStore.getState()
  const d = e.data as EdgeData
  const src = nodes.find((n) => n.id === e.source)
  const dst = nodes.find((n) => n.id === e.target)
  return (
    <aside className="inspector">
      <div className="ins-section first">Связь</div>
      <div className="edge-title">{src?.data.label} → {dst?.data.label}</div>
      <div className="metrics-grid"><Metric label="Поток" value={`${fmtNum(flow)} rps`} /></div>
      <div className="fields">
        <label className="field" title="route — запрос уходит в ОДИН из исходящих route-узлов (балансировка/маршрутизация). call — узел вызывает зависимость на каждый запрос.">
          <span className="f-label">Тип связи</span>
          <select value={d.mode} onChange={(ev) => updateEdge(id, { mode: ev.target.value as EdgeData['mode'] })}>
            <option value="route">route — распределить (LB / маршрут)</option>
            <option value="call">call — вызов зависимости</option>
          </select>
        </label>
        <label className="field" title={d.mode === 'route' ? 'Доля трафика относительно других route-связей узла' : 'Сколько вызовов на один запрос (0.3 = в 30% запросов)'}>
          <span className="f-label">{d.mode === 'route' ? 'Вес маршрута' : 'Вызовов на запрос'}</span>
          <input type="number" min={0} step={0.1} value={d.weight} onChange={(ev) => updateEdge(id, { weight: Math.max(0, Number(ev.target.value)) })} />
        </label>
        <label className="field" title="Какие запросы идут по этой связи">
          <span className="f-label">Тип запросов</span>
          <select value={d.filter} onChange={(ev) => updateEdge(id, { filter: ev.target.value as EdgeData['filter'] })}>
            <option value="all">все</option>
            <option value="read">только чтение (R)</option>
            <option value="write">только запись (W)</option>
          </select>
        </label>
        <label className="field" title="Асинхронная доставка (очередь → воркер): не входит в латентность ответа клиенту">
          <span className="f-label">Асинхронно</span>
          <span className="switch"><input type="checkbox" checked={d.async} onChange={(ev) => updateEdge(id, { async: ev.target.checked })} /><span>{d.async ? 'да' : 'нет'}</span></span>
        </label>
      </div>
      <div className="ins-actions"><button onClick={() => remove(id)}><Trash2 size={14} /> Удалить связь</button></div>
    </aside>
  )
}

function Overview() {
  const last = useStore((s) => s.last)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const slo = useStore((s) => s.slo)
  const setSlo = useStore((s) => s.setSlo)
  const graph = useMemo(() => useStore.getState().graph(), [nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps
  const recs = useMemo(() => {
    const peaks = last ? graph.nodes.map((n) => {
      const m = last.nodes[n.id]
      return { id: n.id, label: n.label, kind: n.kind, peakUtil: m?.utilization ?? 0, peakArrivals: m?.arrivals ?? 0, maxDropPct: m && m.arrivals > 0 ? (m.dropped / m.arrivals) * 100 : 0, maxBacklog: m?.backlog ?? 0, maxLagSec: Number.isFinite(m?.lagSec ?? 0) ? m?.lagSec ?? 0 : 1e9, avgUtil: m?.utilization ?? 0, capacity: m?.capacity ?? 0, instances: m?.instances ?? 0 }
    }) : []
    return recommend(graph, null, undefined, peaks).slice(0, 14)
  }, [graph, last])
  const g = last?.global
  const okP99 = g ? g.p99 <= slo.p99Ms : true
  const okErr = g ? g.errorRate * 100 <= slo.errorPct : true
  return (
    <aside className="inspector">
      <div className="ins-section first">Сводка системы</div>
      {g && (
        <div className="metrics-grid">
          <Metric label="Входящий" value={`${fmtNum(g.offered)} rps`} />
          <Metric label="Успешно" value={`${fmtNum(g.throughput)} rps`} />
          <Metric label="p50" value={fmtMs(g.p50)} />
          <Metric label="p95" value={fmtMs(g.p95)} />
          <Metric label="p99" value={fmtMs(g.p99)} color={okP99 ? '#22c55e' : '#ef4444'} />
          <Metric label="Ошибки" value={fmtPct(g.errorRate, 2)} color={okErr ? '#22c55e' : '#ef4444'} />
          {g.rejectedRate > 0 && <Metric label="Отклонено 429" value={fmtPct(g.rejectedRate, 2)} color="#eab308" />}
          <Metric label="Стоимость" value={`${fmtMoney(g.costMonth)}/мес`} />
          <Metric label="Горлышко" value={g.bottleneck ? nodes.find((n) => n.id === g.bottleneck)?.data.label ?? '—' : 'нет'} color={g.bottleneck ? '#eab308' : '#22c55e'} />
        </div>
      )}
      {last?.warnings.map((w) => <div key={w} className="warn-box">{w}</div>)}
      <div className="ins-section">SLO</div>
      <div className="fields">
        <label className="field"><span className="f-label">p99 не больше <i>мс</i></span><input type="number" min={1} value={slo.p99Ms} onChange={(e) => setSlo({ p99Ms: Math.max(1, Number(e.target.value)) })} /></label>
        <label className="field"><span className="f-label">Ошибок не больше <i>%</i></span><input type="number" min={0} step={0.1} value={slo.errorPct} onChange={(e) => setSlo({ errorPct: Math.max(0, Number(e.target.value)) })} /></label>
      </div>
      <div className="ins-section">Рекомендации ({recs.length})</div>
      <div className="recs">
        {recs.length === 0 && <div className="muted">Пока всё хорошо 👌</div>}
        {recs.map((r, i) => (
          <div key={i} className={`rec rec-${r.severity}`} onClick={() => r.node && useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, selected: n.id === r.node })) })}>
            <b>{r.title}</b>
            <p>{r.detail}</p>
          </div>
        ))}
      </div>
      <p className="muted small">Выберите узел или связь, чтобы редактировать параметры.</p>
    </aside>
  )
}
