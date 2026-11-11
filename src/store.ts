import { addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import { CATALOG, defaultEdgeData } from './sim/catalog'
import { initialState, patternRps, simulateTick, type Pattern } from './sim/engine'
import { autoLayout } from './sim/layout'
import type { ScenarioResult, Slo } from './sim/scenarios'
import { TEMPLATES } from './sim/templates'
import type { EdgeData, Faults, Kind, Params, SimGraph, SimState, TickResult } from './sim/types'

export type ArchNodeData = { kind: Kind; label: string; params: Params; [k: string]: unknown }
export type ArchNode = Node<ArchNodeData, 'arch'>
export type ArchEdge = Edge<EdgeData, 'flow'>

export interface LoadSettings {
  value: number
  unit: 'rps' | 'rpm'
  pattern: Pattern
  period: number
  readRatio: number
}

export interface HistoryPoint {
  t: number
  offered: number
  throughput: number
  errorPct: number
  p50: number
  p95: number
  p99: number
  cost: number
}

interface Snapshot {
  nodes: ArchNode[]
  edges: ArchEdge[]
}

export interface ProjectFile {
  app: 'arch-sim'
  version: 1
  name: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  load: LoadSettings
  slo: Slo
  savedAt: string
}

interface Store {
  projectName: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  load: LoadSettings
  slo: Slo
  running: boolean
  speed: number
  simState: SimState
  last: TickResult | null
  history: HistoryPoint[]
  faults: Faults
  past: Snapshot[]
  future: Snapshot[]
  testResult: ScenarioResult | null
  testsOpen: boolean
  toast: string | null

  baseRps: () => number
  graph: () => SimGraph
  onNodesChange: (c: NodeChange<ArchNode>[]) => void
  onEdgesChange: (c: EdgeChange<ArchEdge>[]) => void
  onConnect: (c: Connection) => void
  addNode: (kind: Kind, pos: { x: number; y: number }) => void
  updateNode: (id: string, patch: Partial<Params> & { label?: string }) => void
  updateEdge: (id: string, patch: Partial<EdgeData>) => void
  duplicate: (id: string) => void
  removeSelected: () => void
  remove: (id: string) => void
  checkpoint: () => void
  undo: () => void
  redo: () => void
  layout: () => void
  loadTemplate: (id: string) => void
  clear: () => void
  setLoad: (p: Partial<LoadSettings>) => void
  setSlo: (p: Partial<Slo>) => void
  setRunning: (r: boolean) => void
  setSpeed: (s: number) => void
  resetSim: () => void
  tick: () => void
  preview: () => void
  toggleFault: (id: string) => void
  setProjectName: (n: string) => void
  toFile: () => ProjectFile
  fromFile: (f: ProjectFile) => void
  setTestResult: (r: ScenarioResult | null) => void
  setTestsOpen: (o: boolean) => void
  showToast: (t: string) => void
}

let idSeq = Date.now() % 100000
const newId = (p: string) => `${p}_${(idSeq++).toString(36)}`

const toRF = (g: SimGraph): Snapshot => {
  const pos = autoLayout(g.nodes, g.edges)
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, type: 'arch', position: pos[n.id], data: { kind: n.kind, label: n.label, params: { ...n.params } } })),
    edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'flow', data: { ...e.data } })),
  }
}

const DEFAULT_LOAD: LoadSettings = { value: 1000, unit: 'rps', pattern: 'constant', period: 120, readRatio: 0.8 }
const DEFAULT_SLO: Slo = { p99Ms: 500, errorPct: 1 }

function initial(): Pick<Store, 'nodes' | 'edges' | 'load' | 'projectName' | 'slo'> {
  try {
    const raw = localStorage.getItem('arch-sim:autosave')
    if (raw) {
      const f = JSON.parse(raw) as ProjectFile
      if (f.app === 'arch-sim' && Array.isArray(f.nodes)) return { nodes: f.nodes, edges: f.edges, load: { ...DEFAULT_LOAD, ...f.load }, projectName: f.name, slo: { ...DEFAULT_SLO, ...f.slo } }
    }
  } catch {
    /* ignore */
  }
  const t = TEMPLATES[0]
  return { ...toRF(t.graph), load: { ...DEFAULT_LOAD, value: t.rps, readRatio: t.readRatio }, projectName: t.title, slo: DEFAULT_SLO }
}

export const useStore = create<Store>((set, get) => ({
  ...initial(),
  running: false,
  speed: 1,
  simState: initialState(),
  last: null,
  history: [],
  faults: {},
  past: [],
  future: [],
  testResult: null,
  testsOpen: false,
  toast: null,

  baseRps: () => {
    const l = get().load
    return l.unit === 'rpm' ? l.value / 60 : l.value
  },
  graph: () => ({
    nodes: get().nodes.map((n) => ({ id: n.id, kind: n.data.kind, label: n.data.label, params: n.data.params })),
    edges: get().edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: e.data ?? defaultEdgeData('webserver') })),
  }),

  onNodesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) get().checkpoint()
    set({ nodes: applyNodeChanges(changes, get().nodes) })
  },
  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) get().checkpoint()
    set({ edges: applyEdgeChanges(changes, get().edges) })
  },
  onConnect: (c) => {
    if (!c.source || !c.target || c.source === c.target) return
    const s = get().nodes.find((n) => n.id === c.source)
    const t = get().nodes.find((n) => n.id === c.target)
    if (!s || !t) return
    get().checkpoint()
    set({ edges: addEdge({ ...c, id: newId('e'), type: 'flow', data: defaultEdgeData(s.data.kind, t.data.kind) }, get().edges) as ArchEdge[] })
  },
  addNode: (kind, pos) => {
    get().checkpoint()
    const def = CATALOG[kind]
    const count = get().nodes.filter((n) => n.data.kind === kind).length
    const node: ArchNode = {
      id: newId(kind), type: 'arch', position: pos,
      data: { kind, label: def.short + (count ? ` ${count + 1}` : ''), params: { ...def.defaults } },
    }
    set({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), { ...node, selected: true }] })
  },
  updateNode: (id, patch) => {
    const { label, ...params } = patch
    set({
      nodes: get().nodes.map((n) => {
        if (n.id !== id) return n
        let p = { ...n.data.params, ...params }
        // CPU масштабирует пропускную способность и цену
        if (params.cpu !== undefined && n.data.params.cpu > 0 && params.cpu !== n.data.params.cpu && patch.maxRps === undefined) {
          const k = params.cpu / n.data.params.cpu
          p = { ...p, maxRps: Math.max(1, Math.round(n.data.params.maxRps * k)), costPerHour: +(n.data.params.costPerHour * k).toFixed(4) }
        }
        return { ...n, data: { ...n.data, label: label ?? n.data.label, params: p } }
      }),
    })
  },
  updateEdge: (id, patch) => {
    get().checkpoint()
    set({ edges: get().edges.map((e) => (e.id === id ? { ...e, data: { ...(e.data as EdgeData), ...patch } } : e)) })
  },
  duplicate: (id) => {
    const n = get().nodes.find((x) => x.id === id)
    if (!n) return
    get().checkpoint()
    const copy: ArchNode = { ...n, id: newId(n.data.kind), position: { x: n.position.x + 40, y: n.position.y + 120 }, selected: true, data: { ...n.data, label: n.data.label + ' (копия)', params: { ...n.data.params } } }
    set({ nodes: [...get().nodes.map((x) => ({ ...x, selected: false })), copy] })
  },
  removeSelected: () => {
    const nodes = get().nodes.filter((n) => n.selected).map((n) => n.id)
    const edges = get().edges.filter((e) => e.selected).map((e) => e.id)
    if (!nodes.length && !edges.length) return
    get().checkpoint()
    set({
      nodes: get().nodes.filter((n) => !nodes.includes(n.id)),
      edges: get().edges.filter((e) => !edges.includes(e.id) && !nodes.includes(e.source) && !nodes.includes(e.target)),
    })
  },
  remove: (id) => {
    get().checkpoint()
    set({ nodes: get().nodes.filter((n) => n.id !== id), edges: get().edges.filter((e) => e.id !== id && e.source !== id && e.target !== id) })
  },
  checkpoint: () => {
    const { nodes, edges, past } = get()
    set({ past: [...past.slice(-60), { nodes, edges }], future: [] })
  },
  undo: () => {
    const { past, future, nodes, edges } = get()
    const prev = past[past.length - 1]
    if (!prev) return
    set({ nodes: prev.nodes, edges: prev.edges, past: past.slice(0, -1), future: [{ nodes, edges }, ...future] })
  },
  redo: () => {
    const { past, future, nodes, edges } = get()
    const next = future[0]
    if (!next) return
    set({ nodes: next.nodes, edges: next.edges, future: future.slice(1), past: [...past, { nodes, edges }] })
  },
  layout: () => {
    get().checkpoint()
    const pos = autoLayout(get().nodes, get().edges)
    set({ nodes: get().nodes.map((n) => ({ ...n, position: pos[n.id] })) })
  },
  loadTemplate: (id) => {
    const t = TEMPLATES.find((x) => x.id === id)
    if (!t) return
    get().checkpoint()
    set({ ...toRF(structuredClone(t.graph)), projectName: t.title, slo: t.slo ?? DEFAULT_SLO, load: { ...get().load, value: get().load.unit === 'rpm' ? t.rps * 60 : t.rps, readRatio: t.readRatio }, faults: {}, history: [], simState: initialState(), testResult: null })
  },
  clear: () => {
    get().checkpoint()
    set({ nodes: [], edges: [], faults: {}, history: [], projectName: 'Новый проект', testResult: null })
  },
  setLoad: (p) => {
    const cur = get().load
    if (p.unit && p.unit !== cur.unit) {
      const v = p.unit === 'rpm' ? cur.value * 60 : cur.value / 60
      set({ load: { ...cur, ...p, value: Math.round(v * 100) / 100 } })
    } else set({ load: { ...cur, ...p } })
  },
  setSlo: (p) => set({ slo: { ...get().slo, ...p } }),
  setRunning: (r) => set({ running: r }),
  setSpeed: (s) => set({ speed: s }),
  resetSim: () => set({ simState: initialState(), history: [], last: null, running: false }),
  tick: () => {
    const { load, speed, simState, faults, history } = get()
    const rps = patternRps(load.pattern, get().baseRps(), simState.t, load.period)
    const res = simulateTick(get().graph(), { rps, readRatio: load.readRatio }, simState, faults, { dt: speed, samples: 1200 })
    const h: HistoryPoint = {
      t: simState.t, offered: rps, throughput: res.global.throughput, errorPct: res.global.errorRate * 100,
      p50: res.global.p50, p95: res.global.p95, p99: res.global.p99, cost: res.global.costMonth,
    }
    set({ simState: res.state, last: res, history: [...history.slice(-149), h] })
  },
  preview: () => {
    const { load, simState, faults } = get()
    const rps = patternRps(load.pattern, get().baseRps(), simState.t, load.period)
    const res = simulateTick(get().graph(), { rps, readRatio: load.readRatio }, { ...simState }, faults, { dt: 0, samples: 1500 })
    set({ last: res })
  },
  toggleFault: (id) => {
    const f = { ...get().faults }
    if (f[id]?.down) delete f[id]
    else f[id] = { down: true }
    set({ faults: f })
  },
  setProjectName: (n) => set({ projectName: n }),
  toFile: () => {
    const { projectName, nodes, edges, load, slo } = get()
    return {
      app: 'arch-sim', version: 1, name: projectName, load, slo, savedAt: new Date().toISOString(),
      nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
      edges: edges.map(({ id, source, target, type, data, sourceHandle, targetHandle }) => ({ id, source, target, type, data, sourceHandle, targetHandle })),
    }
  },
  fromFile: (f) => {
    if (f.app !== 'arch-sim' || !Array.isArray(f.nodes) || !Array.isArray(f.edges)) throw new Error('Это не файл проекта Arch Sim')
    get().checkpoint()
    const nodes = f.nodes.filter((n) => n.data && CATALOG[n.data.kind]).map((n) => ({ ...n, type: 'arch' as const, data: { ...n.data, params: { ...CATALOG[n.data.kind].defaults, ...n.data.params } } }))
    const ids = new Set(nodes.map((n) => n.id))
    const edges = f.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e, type: 'flow' as const }))
    set({ nodes, edges, projectName: f.name || 'Проект', load: { ...DEFAULT_LOAD, ...f.load }, slo: { ...DEFAULT_SLO, ...f.slo }, faults: {}, history: [], simState: initialState(), testResult: null })
  },
  setTestResult: (r) => set({ testResult: r }),
  setTestsOpen: (o) => set({ testsOpen: o }),
  showToast: (t) => {
    set({ toast: t })
    setTimeout(() => get().toast === t && set({ toast: null }), 2600)
  },
}))

// автосохранение
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((s, p) => {
  if (s.nodes === p.nodes && s.edges === p.edges && s.load === p.load && s.projectName === p.projectName && s.slo === p.slo) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('arch-sim:autosave', JSON.stringify(useStore.getState().toFile()))
    } catch {
      /* quota */
    }
  }, 400)
})

export const PROJECTS_KEY = 'arch-sim:projects'
export function listProjects(): ProjectFile[] {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
  } catch {
    return []
  }
}
export function saveProject(f: ProjectFile) {
  const list = listProjects().filter((p) => p.name !== f.name)
  localStorage.setItem(PROJECTS_KEY, JSON.stringify([f, ...list]))
}
export function deleteProject(name: string) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(listProjects().filter((p) => p.name !== name)))
}
