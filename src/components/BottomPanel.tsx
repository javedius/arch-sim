import { Pause, Play, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { COST_PROFILES, type CostProfile } from '../sim/cost'
import { PATTERN_LABELS, type Pattern } from '../sim/engine'
import { useStore } from '../store'
import { fmtMoney, fmtMs, fmtNum, fmtPct } from '../ui/format'

const tip = { contentStyle: { background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }, labelStyle: { color: '#94a3b8' } }

export function BottomPanel() {
  const load = useStore((s) => s.load)
  const running = useStore((s) => s.running)
  const speed = useStore((s) => s.speed)
  const last = useStore((s) => s.last)
  const history = useStore((s) => s.history)
  const slo = useStore((s) => s.slo)
  const t = useStore((s) => s.simState.t)
  const cost = useStore((s) => s.cost)
  const st = useStore.getState()
  const [open, setOpen] = useState(true)
  const g = last?.global
  const max = load.unit === 'rpm' ? 6_000_000 : 100_000
  const logVal = Math.log10(Math.max(1, load.value))
  return (
    <div className={`bottom ${open ? '' : 'collapsed'}`}>
      <div className="controls">
        <div className="ctl-group">
          <button className={running ? 'primary' : 'primary pulse'} onClick={() => st.setRunning(!running)} title="Запустить/пауза живой симуляции">
            {running ? <Pause size={16} /> : <Play size={16} />} {running ? 'Пауза' : 'Старт'}
          </button>
          <button onClick={st.resetSim} title="Сбросить время, очереди и autoscaling"><RotateCcw size={15} /></button>
          <select value={speed} onChange={(e) => st.setSpeed(Number(e.target.value))} title="Скорость симуляции">
            {[1, 2, 5, 10, 30].map((s) => <option key={s} value={s}>×{s}</option>)}
          </select>
          <span className="muted mono">t={Math.round(t)}с</span>
        </div>
        <div className="ctl-group load">
          <span className="ctl-label">Нагрузка</span>
          <input type="range" min={0} max={Math.log10(max)} step={0.01} value={logVal} onChange={(e) => st.setLoad({ value: Math.round(10 ** Number(e.target.value)) })} />
          <input type="number" className="num" min={0} value={load.value} onChange={(e) => st.setLoad({ value: Math.max(0, Number(e.target.value)) })} />
          <div className="seg">
            {(['rps', 'rpm'] as const).map((u) => <button key={u} className={load.unit === u ? 'on' : ''} onClick={() => st.setLoad({ unit: u })}>{u.toUpperCase()}</button>)}
          </div>
        </div>
        <div className="ctl-group">
          <span className="ctl-label">Паттерн</span>
          <select value={load.pattern} onChange={(e) => st.setLoad({ pattern: e.target.value as Pattern })}>
            {Object.entries(PATTERN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {load.pattern !== 'constant' && (
            <label className="mini" title="Длина цикла паттерна в секундах симуляции">цикл <input type="number" className="num s" min={10} value={load.period} onChange={(e) => st.setLoad({ period: Math.max(10, Number(e.target.value)) })} />с</label>
          )}
        </div>
        <div className="ctl-group">
          <span className="ctl-label" title="Доля чтений во входящем трафике">Чтение/запись</span>
          <input type="range" min={0} max={100} value={Math.round(load.readRatio * 100)} onChange={(e) => st.setLoad({ readRatio: Number(e.target.value) / 100 })} />
          <span className="mono">{Math.round(load.readRatio * 100)}/{100 - Math.round(load.readRatio * 100)}</span>
        </div>
        <div className="ctl-group">
          <span className="ctl-label" title="Как считать месячную стоимость: нагрузка в поле «Нагрузка» — это пик">Стоимость по</span>
          <select value={load.costProfile} title={COST_PROFILES[load.costProfile].hint} onChange={(e) => st.setLoad({ costProfile: e.target.value as CostProfile })}>
            {Object.entries(COST_PROFILES).map(([k, v]) => <option key={k} value={k}>{v.label} (≈{Math.round(v.ratio * 100)}%)</option>)}
          </select>
        </div>
        <button className="icon collapse" onClick={() => setOpen(!open)} title={open ? 'Свернуть графики' : 'Развернуть графики'}>{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>
      </div>
      {g && (
        <div className="kpis">
          <div className="kpi"><span>Сейчас</span><b>{fmtNum(g.offered)} rps</b><i>{fmtNum(g.offered * 60)} rpm</i></div>
          {cost && <div className="kpi"><span>Пик / средний</span><b>{fmtNum(cost.peakRps)} / {fmtNum(cost.avgRps)}</b><i>rps · {COST_PROFILES[cost.profile].label.toLowerCase()}</i></div>}
          <div className="kpi"><span>Throughput</span><b>{fmtNum(g.throughput)} rps</b></div>
          <div className="kpi"><span>p50</span><b>{fmtMs(g.p50)}</b></div>
          <div className="kpi"><span>p95</span><b>{fmtMs(g.p95)}</b></div>
          <div className={`kpi ${g.p99 > slo.p99Ms ? 'bad' : 'good'}`}><span>p99</span><b>{fmtMs(g.p99)}</b><i>SLO {slo.p99Ms} мс</i></div>
          <div className={`kpi ${g.errorRate * 100 > slo.errorPct ? 'bad' : 'good'}`}><span>Ошибки</span><b>{fmtPct(g.errorRate, 2)}</b>{g.rejectedRate > 0 && <i>429: {fmtPct(g.rejectedRate, 1)}</i>}</div>
          <div className="kpi"><span>Пик загрузки</span><b>{fmtPct(Math.min(g.maxUtil, 9.99), 0)}</b></div>
          {cost && <div className="kpi cost" title={`Переменная (токены, запросы): ${fmtMoney(cost.variable)} · фиксированная (инстансы): ${fmtMoney(cost.fixed)}`}><span>Стоимость / мес</span><b>{fmtMoney(cost.total)}</b><i>по среднему · пик 24/7: {fmtMoney(cost.totalAtPeak)}</i></div>}
          {cost && cost.avgRps > 0 && <div className="kpi"><span>$ / 1M запросов</span><b>{fmtMoney(cost.perMillionRequests)}</b><i>{fmtNum(cost.avgRps * 2_628_000)} запр./мес</i></div>}
        </div>
      )}
      {open && (
        <div className="charts">
          {history.length < 2 ? (
            <div className="chart-empty">Нажмите <b>Старт</b>, чтобы запустить живую симуляцию и увидеть графики во времени. Или откройте <b>Тест-планы</b>.</div>
          ) : (
            <>
              <div className="chart">
                <div className="chart-title">Трафик, rps</div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" />
                    <XAxis dataKey="t" stroke="#64748b" fontSize={10} />
                    <YAxis stroke="#64748b" fontSize={10} tickFormatter={(v) => fmtNum(v)} />
                    <Tooltip {...tip} formatter={(v) => fmtNum(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line dataKey="offered" name="вход" stroke="#60a5fa" dot={false} isAnimationActive={false} />
                    <Line dataKey="throughput" name="успешно" stroke="#22c55e" dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="chart">
                <div className="chart-title">Латентность, мс</div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" />
                    <XAxis dataKey="t" stroke="#64748b" fontSize={10} />
                    <YAxis stroke="#64748b" fontSize={10} />
                    <Tooltip {...tip} formatter={(v) => fmtMs(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line dataKey="p50" stroke="#22c55e" dot={false} isAnimationActive={false} />
                    <Line dataKey="p95" stroke="#eab308" dot={false} isAnimationActive={false} />
                    <Line dataKey="p99" stroke="#ef4444" dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="chart">
                <div className="chart-title">Ошибки, %</div>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={history} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" />
                    <XAxis dataKey="t" stroke="#64748b" fontSize={10} />
                    <YAxis stroke="#64748b" fontSize={10} />
                    <Tooltip {...tip} formatter={(v) => Number(v).toFixed(2) + '%'} />
                    <Line dataKey="errorPct" name="ошибки" stroke="#ef4444" dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
