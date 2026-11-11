import dagre from '@dagrejs/dagre'

export function autoLayout<N extends { id: string }>(nodes: N[], edges: { source: string; target: string }[], dir: 'LR' | 'TB' = 'LR') {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: dir, nodesep: 30, ranksep: 60, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  nodes.forEach((n) => g.setNode(n.id, { width: 200, height: 96 }))
  edges.forEach((e) => g.setEdge(e.source, e.target))
  dagre.layout(g)
  const pos: Record<string, { x: number; y: number }> = {}
  nodes.forEach((n) => {
    const p = g.node(n.id)
    pos[n.id] = { x: p.x - 100, y: p.y - 48 }
  })
  return pos
}
