import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useState } from 'react'
import { ArchNode } from './components/ArchNode'
import { BottomPanel } from './components/BottomPanel'
import { FlowEdge } from './components/FlowEdge'
import { Header } from './components/Header'
import { Inspector } from './components/Inspector'
import { Palette } from './components/Palette'
import { TestPlans } from './components/TestPlans'
import { Help } from './components/Help'
import { CATALOG } from './sim/catalog'
import type { Kind } from './sim/types'
import { useStore, type ArchEdge, type ArchNode as ArchNodeT } from './store'
import { STATUS_COLOR } from './ui/format'

const nodeTypes = { arch: ArchNode }
const edgeTypes = { flow: FlowEdge }

function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const st = useStore.getState()
  const rf = useReactFlow()

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const kind = e.dataTransfer.getData('application/arch-kind') as Kind
    if (!kind || !CATALOG[kind]) return
    const pos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    st.addNode(kind, { x: pos.x - 100, y: pos.y - 40 })
  }, [rf, st])

  return (
    <div className="canvas" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}>
      <ReactFlow<ArchNodeT, ArchEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={st.onNodesChange}
        onEdgesChange={st.onEdgesChange}
        onConnect={st.onConnect}
        onNodeDragStart={() => st.checkpoint()}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        snapToGrid
        snapGrid={[10, 10]}
        deleteKeyCode={['Delete', 'Backspace']}
        colorMode="dark"
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#1e293b" />
        <MiniMap pannable zoomable nodeColor={(n) => {
          const m = useStore.getState().last?.nodes[n.id]
          return useStore.getState().faults[n.id]?.down ? STATUS_COLOR.down : m ? STATUS_COLOR[m.status] : '#475569'
        }} maskColor="rgba(2,6,23,0.7)" style={{ background: '#0f172a' }} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {nodes.length === 0 && <div className="empty-hint">Перетащите компоненты слева или выберите шаблон в «Шаблоны»</div>}
    </div>
  )
}

function Shell() {
  const running = useStore((s) => s.running)
  const speed = useStore((s) => s.speed)
  const nodes = useStore((s) => s.nodes)
  const edges = useStore((s) => s.edges)
  const load = useStore((s) => s.load)
  const faults = useStore((s) => s.faults)
  const toast = useStore((s) => s.toast)
  const [help, setHelp] = useState(false)
  const rf = useReactFlow()

  // живая симуляция
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => useStore.getState().tick(), 400)
    return () => clearInterval(t)
  }, [running, speed])

  // превью метрик при изменениях на паузе
  useEffect(() => {
    if (running) return
    const t = setTimeout(() => useStore.getState().preview(), 60)
    return () => clearTimeout(t)
  }, [nodes, edges, load, faults, running])

  // горячие клавиши
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useStore.getState().redo()
      } else if (e.key === ' ' && !mod) {
        e.preventDefault()
        useStore.getState().setRunning(!useStore.getState().running)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const addCenter = (k: Kind) => {
    const el = document.querySelector('.canvas')!.getBoundingClientRect()
    const p = rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 })
    useStore.getState().addNode(k, { x: p.x - 100 + Math.random() * 60, y: p.y - 40 + Math.random() * 60 })
  }

  return (
    <div className="app">
      <Header onHelp={() => setHelp(true)} />
      <div className="main">
        <Palette onAdd={addCenter} />
        <Canvas />
        <Inspector />
      </div>
      <BottomPanel />
      <TestPlans />
      {help && <Help onClose={() => setHelp(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  )
}
