import { CheckCircle2, Download, Loader2, Play, X, XCircle, ListChecks } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { reportMarkdown, runScenario, SCENARIOS, type ScenarioId, type ScenarioResult } from '../sim/scenarios'
import { useStore } from '../store'
import { fmtMoney, fmtMs, fmtNum } from '../ui/format'
import { download, safe } from './Header'

const tip = { contentStyle: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }, labelStyle: { color: '#94a3b8' } }
const COLORS = ['#ef4444', '#f59e0b', '#a78bfa', '#22d3ee', '#4ade80']
const tLabel = (t: number) => (t >= 3600 ? `${(t / 3600).toFixed(1)}ч` : t >= 600 ? `${Math.round(t / 60)}м` : `${t}с`)

export function TestPlans() {
  const open = useStore((s) => s.testsOpen)
  const result = useStore((s) => s.testResult)
  const nodes = useStore((s) => s.nodes)
  const slo = useStore((s) => s.slo)
  const st = useStore.getState()
  const [sel, setSel] = useState<ScenarioId>('load')
  const [target, setTarget] = useState<string>('')
  const [rps, setRps] = useState<number>(() => Math.round(st.baseRps()))
  const [busy, setBusy] = useState(false)
  const [suite, setSuite] = useState<ScenarioResult[] | null>(null)
  useEffect(() => {
    if (open) setRps(Math.max(1, Math.round(useStore.getState().baseRps())))
  }, [open])
  if (!open) return null
  const sc = SCENARIOS.find((s) => s.id === sel)!
  const candidates = nodes.filter((n) => n.data.kind !== 'client')
  const tgt = target && candidates.some((n) => n.id === target) ? target : candidates.find((n) => ['sqldb', 'cache', 'webserver'].includes(n.data.kind))?.id ?? candidates[0]?.id

  const run = (ids: ScenarioId[]) => {
    setBusy(true)
    setTimeout(() => {
      const g = st.graph()
      const results = ids.map((id) => runScenario(g, id, { baseRps: rps, readRatio: st.load.readRatio, slo, target: tgt }))
      if (ids.length > 1) {
        setSuite(results)
        st.setTestResult(null)
      } else {
        setSuite(null)
        st.setTestResult(results[0])
      }
      setBusy(false)
    }, 30)
  }

  return (
    <div className="modal-bg" onClick={() => st.setTestsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Тест-планы</h2>
          <span className="muted">Прогон архитектуры по сценариям с отчётом и рекомендациями</span>
          <button className="icon" onClick={() => st.setTestsOpen(false)}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="sc-list">
            {SCENARIOS.map((s) => (
              <div key={s.id} className={`sc-item ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>
                <b>{s.title}</b>
                <span>{s.goal}</span>
              </div>
            ))}
          </div>
          <div className="sc-main">
            <div className="sc-config">
              <label className="field"><span className="f-label">Целевая нагрузка <i>rps</i></span><input type="number" min={1} value={rps} onChange={(e) => setRps(Math.max(1, Number(e.target.value)))} /></label>
              {sc.needsTarget && (
                <label className="field"><span className="f-label">Какой узел убить</span>
                  <select value={tgt} onChange={(e) => setTarget(e.target.value)}>{candidates.map((n) => <option key={n.id} value={n.id}>{n.data.label}</option>)}</select>
                </label>
              )}
              <div className="muted small">SLO: p99 ≤ {slo.p99Ms} мс, ошибки ≤ {slo.errorPct}% · длительность {tLabel(sc.durationSec)} · чтение {Math.round(st.load.readRatio * 100)}%</div>
              <div className="row gap">
                <button className="primary" disabled={busy || !nodes.length} onClick={() => run([sel])}>{busy ? <Loader2 className="spin" size={15} /> : <Play size={15} />} Запустить</button>
                <button disabled={busy || !nodes.length} onClick={() => run(SCENARIOS.map((s) => s.id))}><ListChecks size={15} /> Прогнать все</button>
              </div>
            </div>
            {suite && <SuiteView results={suite} onOpen={(r) => { setSuite(null); st.setTestResult(r) }} />}
            {result && !suite && <ResultView r={result} />}
            {!result && !suite && <div className="chart-empty">Выберите сценарий и нажмите «Запустить». Симуляция пройдёт в ускоренном времени.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function SuiteView({ results, onOpen }: { results: ScenarioResult[]; onOpen: (r: ScenarioResult) => void }) {
  const slo = useStore((s) => s.slo)
  const graph = useStore.getState().graph()
  const md = () => results.map((r) => reportMarkdown(graph, r, slo)).join('\n\n---\n\n')
  return (
    <div className="result">
      <div className="row between"><h3>Результаты набора тестов</h3><button onClick={() => download(`${safe(useStore.getState().projectName)}-tests.md`, md(), 'text/markdown')}><Download size={14} /> Отчёт .md</button></div>
      <table className="tbl">
        <thead><tr><th>Сценарий</th><th>Итог</th><th>макс p99</th><th>макс ошибки</th><th>Детали</th></tr></thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.scenario.id} onClick={() => onOpen(r)}>
              <td>{r.scenario.title}</td>
              <td>{r.summary.passed ? <span className="pass"><CheckCircle2 size={14} /> пройден</span> : <span className="fail"><XCircle size={14} /> провален</span>}</td>
              <td>{fmtMs(r.summary.maxP99)}</td>
              <td>{r.summary.maxErrorPct.toFixed(2)}%</td>
              <td className="muted">{r.summary.breakingRps ? `отказ ~${fmtNum(r.summary.breakingRps)} rps` : r.scenario.id === 'stress' ? `выдержал ×4 (${fmtNum(r.baseRps * 4)} rps)` : r.summary.recoverySec !== undefined ? `восст. ${r.summary.recoverySec}с` : r.summary.sloViolations[0] ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Кликните по строке, чтобы открыть графики и рекомендации.</p>
    </div>
  )
}

function ResultView({ r }: { r: ScenarioResult }) {
  const slo = useStore((s) => s.slo)
  const nodes = useStore((s) => s.nodes)
  const top = useMemo(() => [...r.peaks].filter((p) => p.kind !== 'client').sort((a, b) => b.peakUtil - a.peakUtil).slice(0, 5), [r])
  const s = r.summary
  const label = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id
  return (
    <div className="result">
      <div className="row between">
        <h3>{r.scenario.title} — {s.passed ? <span className="pass"><CheckCircle2 size={16} /> SLO выполнен</span> : <span className="fail"><XCircle size={16} /> SLO нарушен</span>}</h3>
        <button onClick={() => download(`${safe(useStore.getState().projectName)}-${r.scenario.id}.md`, reportMarkdown(useStore.getState().graph(), r, slo), 'text/markdown')}><Download size={14} /> Отчёт .md</button>
      </div>
      {s.sloViolations.length > 0 && <div className="warn-box">{s.sloViolations.join(' · ')}</div>}
      <div className="kpis inline">
        <div className="kpi"><span>Макс p99</span><b>{fmtMs(s.maxP99)}</b></div>
        <div className="kpi"><span>Средний p99</span><b>{fmtMs(s.avgP99)}</b></div>
        <div className="kpi"><span>Макс ошибки</span><b>{s.maxErrorPct.toFixed(2)}%</b></div>
        <div className="kpi"><span>Пик throughput</span><b>{fmtNum(s.peakThroughput)} rps</b></div>
        {s.breakingRps !== undefined && <div className="kpi bad"><span>Точка отказа</span><b>{fmtNum(s.breakingRps)} rps</b></div>}
        {s.recoverySec !== undefined && <div className="kpi"><span>Восстановление</span><b>{s.recoverySec} с</b></div>}
        <div className="kpi"><span>Стоимость</span><b>{fmtMoney(s.avgCostMonth)}/мес</b></div>
      </div>
      <div className="res-charts">
        <div className="chart big">
          <div className="chart-title">Трафик: вход vs успешно (rps)</div>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={r.series} margin={{ top: 4, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="t" stroke="#64748b" fontSize={10} tickFormatter={tLabel} />
              <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => fmtNum(v)} />
              <Tooltip {...tip} labelFormatter={(v) => tLabel(Number(v))} formatter={(v) => fmtNum(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area dataKey="offered" name="вход" stroke="#60a5fa" fill="#60a5fa22" isAnimationActive={false} />
              <Area dataKey="throughput" name="успешно" stroke="#22c55e" fill="#22c55e33" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="chart big">
          <div className="chart-title">Латентность p50 / p95 / p99 (мс)</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={r.series} margin={{ top: 4, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="t" stroke="#64748b" fontSize={10} tickFormatter={tLabel} />
              <YAxis stroke="#64748b" fontSize={10} />
              <Tooltip {...tip} labelFormatter={(v) => tLabel(Number(v))} formatter={(v) => fmtMs(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="p50" stroke="#22c55e" dot={false} isAnimationActive={false} />
              <Line dataKey="p95" stroke="#eab308" dot={false} isAnimationActive={false} />
              <Line dataKey="p99" stroke="#ef4444" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart big">
          <div className="chart-title">Ошибки и отказы 429 (%)</div>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={r.series} margin={{ top: 4, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="t" stroke="#64748b" fontSize={10} tickFormatter={tLabel} />
              <YAxis stroke="#64748b" fontSize={10} />
              <Tooltip {...tip} labelFormatter={(v) => tLabel(Number(v))} formatter={(v) => Number(v).toFixed(2) + '%'} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area dataKey="errorPct" name="ошибки" stroke="#ef4444" fill="#ef444433" isAnimationActive={false} />
              <Area dataKey="rejectedPct" name="429" stroke="#eab308" fill="#eab30822" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="chart big">
          <div className="chart-title">Загрузка самых горячих узлов (%)</div>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={r.series} margin={{ top: 4, right: 10, left: -6, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="t" stroke="#64748b" fontSize={10} tickFormatter={tLabel} />
              <YAxis stroke="#64748b" fontSize={10} domain={[0, 100]} />
              <Tooltip {...tip} labelFormatter={(v) => tLabel(Number(v))} formatter={(v) => Number(v).toFixed(0) + '%'} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {top.map((p, i) => <Line key={p.id} dataKey={'u_' + p.id} name={label(p.id)} stroke={COLORS[i]} dot={false} isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <h3>Рекомендации</h3>
      <div className="recs">
        {r.recommendations.length === 0 && <div className="muted">Замечаний нет — архитектура выдержала сценарий.</div>}
        {r.recommendations.map((x, i) => (
          <div key={i} className={`rec rec-${x.severity}`}><b>{x.title}</b><p>{x.detail}</p></div>
        ))}
      </div>
    </div>
  )
}
