import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import { CATALOG } from '../sim/catalog'
import { useStore, type ArchNode as ArchNodeT } from '../store'
import { fmtMs, fmtNum, STATUS_COLOR } from '../ui/format'
import { KIND_ICON } from '../ui/icons'

function ArchNodeImpl({ id, data, selected }: NodeProps<ArchNodeT>) {
  const m = useStore((s) => s.last?.nodes[id])
  const faulted = useStore((s) => !!s.faults[id]?.down)
  const def = CATALOG[data.kind]
  const Icon = KIND_ICON[data.kind]
  const p = data.params
  const status = faulted ? 'down' : (m?.status ?? 'idle')
  const color = STATUS_COLOR[status]
  const util = Math.min(1, m?.utilization ?? 0)
  let badge = ''
  if (data.kind === 'sqldb') badge = `P${(p.shards ?? 1) > 1 ? '×' + p.shards : ''}${p.replicas ? ' +' + p.replicas + 'R' : ''}`
  else if (data.kind !== 'client' && !['dns', 'cdn', 'objectstorage', 'external', 'llmapi'].includes(data.kind)) badge = `×${m?.instances ?? p.instances}`
  return (
    <div className={`arch-node status-${status} ${selected ? 'selected' : ''}`} style={{ ['--accent' as string]: def.color, ['--status' as string]: color }}>
      <Handle type="target" position={Position.Left} />
      <div className="an-head">
        <div className="an-icon" style={{ background: def.color + '22', color: def.color }}>
          <Icon size={18} />
        </div>
        <div className="an-title">
          <div className="an-label" title={data.label}>{data.label}</div>
          <div className="an-kind">{def.short}{p.engine ? ` · ${p.engine}` : ''}{data.kind === 'gpullm' ? ` · ${p.gpuType} b${p.batchSize}` : ''}{data.kind === 'agent' ? ` · ${p.steps} шаг.` : ''}{(data.kind === 'llmapi' || data.kind === 'gpullm') ? ` · ${p.inTokens}/${p.outTokens} tok` : ''}{p.autoscale ? ' · auto' : ''}</div>
        </div>
        {badge && <div className="an-badge">{badge}</div>}
      </div>
      {data.kind === 'client' ? (
        <div className="an-stats"><span>{fmtNum(m?.arrivals ?? 0)} rps</span><span>{p.region}</span></div>
      ) : (
        <>
          <div className="an-bar"><div style={{ width: `${util * 100}%`, background: color }} /></div>
          <div className="an-stats">
            <span title="Входящий трафик">{fmtNum(m?.arrivals ?? 0)} rps</span>
            <span title="Загрузка">{Math.round((m?.utilization ?? 0) * 100)}%</span>
            <span title="Собственная латентность">{fmtMs(m?.latencyMs ?? p.latencyMs)}</span>
          </div>
          {(status === 'down' || (m && (m.dropped > 0.5 || (m.backlog ?? 0) > 1))) && (
            <div className="an-alert">
              {status === 'down' ? (data.kind === 'cache' ? 'DOWN · bypass в БД' : 'DOWN') : m!.dropped > 0.5 ? `потери ${fmtNum(m!.dropped)} rps` : `lag ${fmtNum(m!.backlog ?? 0)} msg`}
            </div>
          )}
        </>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
export const ArchNode = memo(ArchNodeImpl)
