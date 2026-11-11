import { useReactFlow } from '@xyflow/react'
import { toPng } from 'html-to-image'
import { FileJson, FlaskConical, FolderOpen, Image, LayoutGrid, LayoutTemplate, Redo2, Save, Trash2, Undo2, Upload, HelpCircle, FilePlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { TEMPLATES } from '../sim/templates'
import { deleteProject, listProjects, saveProject, useStore, type ProjectFile } from '../store'

function download(name: string, data: string, type = 'application/json') {
  const a = document.createElement('a')
  a.href = data.startsWith('data:') ? data : URL.createObjectURL(new Blob([data], { type }))
  a.download = name
  a.click()
}
const safe = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'project'

export function Header({ onHelp }: { onHelp: () => void }) {
  const name = useStore((s) => s.projectName)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const st = useStore.getState()
  const [menu, setMenu] = useState<'tpl' | 'proj' | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const rf = useReactFlow()

  const exportPng = async () => {
    const el = document.querySelector('.react-flow') as HTMLElement
    if (!el) return
    rf.fitView({ padding: 0.1 })
    await new Promise((r) => setTimeout(r, 350))
    const url = await toPng(el, {
      backgroundColor: '#0b1020', pixelRatio: 2,
      filter: (n) => !(n instanceof HTMLElement && (n.classList.contains('react-flow__minimap') || n.classList.contains('react-flow__controls') || n.classList.contains('react-flow__panel'))),
    })
    download(`${safe(name)}.png`, url)
  }

  return (
    <header className="header">
      <div className="brand"><span className="logo">◆</span> Arch Sim <span className="muted">· проектирование и нагрузка</span></div>
      <input className="proj-name" value={name} onChange={(e) => st.setProjectName(e.target.value)} title="Название проекта" />
      <div className="tools">
        <div className="dd">
          <button onClick={() => setMenu(menu === 'tpl' ? null : 'tpl')}><LayoutTemplate size={15} /> Шаблоны</button>
          {menu === 'tpl' && (
            <div className="dd-menu" onMouseLeave={() => setMenu(null)}>
              {TEMPLATES.map((t) => (
                <div key={t.id} className="dd-item" onClick={() => { st.loadTemplate(t.id); setMenu(null); setTimeout(() => rf.fitView({ padding: 0.15 }), 50) }}>
                  <b>{t.title}</b><span>{t.description}</span>
                </div>
              ))}
              <div className="dd-item" onClick={() => { st.clear(); setMenu(null) }}><b><FilePlus size={13} /> Пустой проект</b><span>Начать с чистого холста</span></div>
            </div>
          )}
        </div>
        <button disabled={!canUndo} onClick={st.undo} title="Отменить (Ctrl+Z)"><Undo2 size={15} /></button>
        <button disabled={!canRedo} onClick={st.redo} title="Повторить (Ctrl+Shift+Z)"><Redo2 size={15} /></button>
        <button onClick={() => { st.layout(); setTimeout(() => rf.fitView({ padding: 0.15 }), 50) }} title="Авто-раскладка"><LayoutGrid size={15} /> Раскладка</button>
        <span className="sep" />
        <button onClick={() => { saveProject(st.toFile()); st.showToast(`Проект «${name}» сохранён в браузере`) }} title="Сохранить в localStorage"><Save size={15} /> Сохранить</button>
        <div className="dd">
          <button onClick={() => setMenu(menu === 'proj' ? null : 'proj')}><FolderOpen size={15} /> Проекты</button>
          {menu === 'proj' && (
            <div className="dd-menu" onMouseLeave={() => setMenu(null)}>
              {listProjects().length === 0 && <div className="dd-item"><span>Сохранённых проектов пока нет</span></div>}
              {listProjects().map((p) => (
                <div key={p.name} className="dd-item row" onClick={() => { st.fromFile(p); setMenu(null); setTimeout(() => rf.fitView({ padding: 0.15 }), 50) }}>
                  <div><b>{p.name}</b><span>{p.nodes.length} узлов · {new Date(p.savedAt).toLocaleString('ru-RU')}</span></div>
                  <button className="icon" onClick={(e) => { e.stopPropagation(); deleteProject(p.name); setMenu(null) }}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => download(`${safe(name)}.arch.json`, JSON.stringify(st.toFile(), null, 2))} title="Экспорт JSON"><FileJson size={15} /> JSON</button>
        <button onClick={() => file.current?.click()} title="Импорт JSON"><Upload size={15} /></button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0]
          if (!f) return
          try {
            st.fromFile(JSON.parse(await f.text()) as ProjectFile)
            st.showToast('Проект импортирован')
            setTimeout(() => rf.fitView({ padding: 0.15 }), 50)
          } catch (err) {
            st.showToast('Ошибка импорта: ' + (err as Error).message)
          }
          e.target.value = ''
        }} />
        <button onClick={exportPng} title="Экспорт PNG"><Image size={15} /> PNG</button>
        <span className="sep" />
        <button className="primary" onClick={() => st.setTestsOpen(true)}><FlaskConical size={15} /> Тест-планы</button>
        <button onClick={onHelp} title="Справка"><HelpCircle size={15} /></button>
      </div>
    </header>
  )
}
export { download, safe }
