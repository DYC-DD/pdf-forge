import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { FilePlus2, Plus, UploadCloud } from 'lucide-react'

export default function DropZone({
  multiple,
  onFiles,
  compact = false,
}: {
  multiple: boolean
  onFiles: (files: File[]) => void
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    onFiles(Array.from(event.dataTransfer.files))
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  return (
    <div
      className={`drop-zone ${compact ? 'drop-zone--compact' : ''} ${dragging ? 'drop-zone--dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".pdf,application/pdf"
        multiple={multiple}
        onChange={handleChange}
        aria-label={multiple ? '選擇多份 PDF' : '選擇一份 PDF'}
      />
      <div className="drop-icon"><UploadCloud size={compact ? 20 : 27} strokeWidth={1.8} /></div>
      <div className="drop-copy">
        <strong>{compact ? '繼續加入 PDF' : `拖曳${multiple ? '多份' : '一份'} PDF 到這裡`}</strong>
        {!compact && <span>或從裝置選取檔案，僅支援 .pdf</span>}
      </div>
      <button className={compact ? 'button button--small button--outline' : 'button button--dark'} onClick={() => inputRef.current?.click()}>
        {compact ? <Plus size={16} /> : <FilePlus2 size={18} />}
        {compact ? '加入檔案' : '選擇 PDF'}
      </button>
    </div>
  )
}
