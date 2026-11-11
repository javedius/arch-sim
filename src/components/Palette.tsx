import { CATALOG, KINDS, type Category } from '../sim/catalog'
import type { Kind } from '../sim/types'
import { KIND_ICON } from '../ui/icons'
import { useState } from 'react'

const CATS: Category[] = ['Вход', 'AI', 'Сеть', 'Вычисления', 'Данные', 'Асинхронность', 'Внешнее']

export function Palette({ onAdd }: { onAdd: (k: Kind) => void }) {
  const [q, setQ] = useState('')
  const match = (k: Kind) => !q || (CATALOG[k].title + CATALOG[k].short).toLowerCase().includes(q.toLowerCase())
  return (
    <aside className="palette">
      <input className="search" placeholder="Поиск компонента…" value={q} onChange={(e) => setQ(e.target.value)} />
      {CATS.map((cat) => {
        const items = KINDS.filter((k) => CATALOG[k].category === cat && match(k))
        if (!items.length) return null
        return (
          <div key={cat} className="pal-group">
            <div className="pal-cat">{cat}</div>
            {items.map((k) => {
              const d = CATALOG[k]
              const Icon = KIND_ICON[k]
              return (
                <div
                  key={k}
                  className="pal-item"
                  draggable
                  title={d.description + '\n\nПеретащите на холст или кликните, чтобы добавить.'}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/arch-kind', k)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onAdd(k)}
                  data-kind={k}
                >
                  <span className="pal-icon" style={{ color: d.color, background: d.color + '1f' }}><Icon size={16} /></span>
                  <span>{d.title}</span>
                </div>
              )
            })}
          </div>
        )
      })}
      <div className="pal-hint">Тяните компонент на холст. Соединяйте узлы, перетаскивая точку справа к точке слева. Delete — удалить.</div>
    </aside>
  )
}
