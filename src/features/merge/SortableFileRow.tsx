import { ArrowDown, ArrowUp, Files, GripVertical, X } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { formatBytes } from '../../shared/pdf/pdf'
import type { MergeItem } from './types'

export default function SortableFileRow({
  item,
  position,
  total,
  disabled,
  onMove,
  onRemove,
}: {
  item: MergeItem
  position: number
  total: number
  disabled: boolean
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled })
  return (
    <div
      ref={setNodeRef}
      className={`file-row ${isDragging ? 'file-row--dragging' : ''} ${item.error ? 'file-row--error' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="file-index">{String(position + 1).padStart(2, '0')}</div>
      <div className="file-preview">
        {item.thumbnail ? <img src={item.thumbnail} alt="PDF 首頁預覽" /> : <Files size={24} strokeWidth={1.5} />}
      </div>
      <div className="file-info">
        <strong title={item.file.name}>{item.file.name}</strong>
        <span>
          {formatBytes(item.file.size)}
          {item.loading ? ' · 讀取中…' : item.error ? ` · ${item.error}` : ` · ${item.pageCount} 頁`}
        </span>
      </div>
      <div className="row-controls">
        <div className="step-controls">
          <button className="icon-button" onClick={() => onMove(-1)} disabled={disabled || position === 0} aria-label={`將 ${item.file.name} 上移`} title="上移"><ArrowUp size={16} /></button>
          <button className="icon-button" onClick={() => onMove(1)} disabled={disabled || position === total - 1} aria-label={`將 ${item.file.name} 下移`} title="下移"><ArrowDown size={16} /></button>
        </div>
        <button className="icon-button drag-handle" {...attributes} {...listeners} disabled={disabled} aria-label={`拖曳排序 ${item.file.name}`} title="拖曳排序"><GripVertical size={19} /></button>
        <button className="icon-button icon-button--danger" onClick={onRemove} disabled={disabled} aria-label={`移除 ${item.file.name}`} title="移除"><X size={17} /></button>
      </div>
    </div>
  )
}
