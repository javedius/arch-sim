import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { memo } from 'react'
import { useStore, type ArchEdge } from '../store'
import { fmtNum, STATUS_COLOR } from '../ui/format'

function FlowEdgeImpl({ id, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<ArchEdge>) {
  const flow = useStore((s) => s.last?.edges[id] ?? 0)
  const tStatus = useStore((s) => (s.faults[target]?.down ? 'down' : s.last?.nodes[target]?.status ?? 'idle'))
  const running = useStore((s) => s.running)
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const color = flow > 0 ? STATUS_COLOR[tStatus] : '#475569'
  const width = flow > 0 ? Math.min(6, 1.2 + Math.log10(1 + flow) * 1.1) : 1.2
  const dots = flow > 0 ? Math.min(4, 1 + Math.floor(Math.log10(1 + flow))) : 0
  const dur = Math.max(0.6, 2.6 - Math.log10(1 + flow) * 0.4)
  const tag = [data?.mode === 'call' ? (data.weight !== 1 ? `×${data.weight}` : '') : data?.weight !== 1 ? `w${data?.weight}` : '', data?.filter !== 'all' ? (data?.filter === 'read' ? 'R' : 'W') : '', data?.async ? 'async' : ''].filter(Boolean).join(' ')
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: selected ? '#e2e8f0' : color, strokeWidth: selected ? width + 1.5 : width, strokeDasharray: data?.async ? '6 5' : undefined, opacity: flow > 0 ? 0.9 : 0.6 }} />
      {running && dots > 0 &&
        Array.from({ length: dots }).map((_, i) => (
          <circle key={i} r={2.6} fill={color}>
            <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(i * dur) / dots}s`} path={path} />
          </circle>
        ))}
      <EdgeLabelRenderer>
        <div className="edge-label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px,${ly}px)` }}>
          {flow > 0 ? `${fmtNum(flow)}/s` : ''}{tag ? <em> {tag}</em> : null}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
export const FlowEdge = memo(FlowEdgeImpl)
