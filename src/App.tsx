import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCheck,
  Download,
  FilePlus2,
  FileStack,
  Files,
  GripVertical,
  LockKeyhole,
  Plus,
  Scissors,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import { fileStem, formatBytes, mergePdfs, parsePageRange, saveBlob, splitPdf, type PageGroup } from './lib/pdf'
import { inspectPdf, openPdf, renderPageThumbnail } from './lib/preview'

type Tool = 'merge' | 'split'
type MergeItem = {
  id: string
  file: File
  loading: boolean
  pageCount?: number
  thumbnail?: string
  error?: string
}

function fileError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('這份 PDF 無法以空密碼開啟')) {
    return error.message
  }
  if (error instanceof Error && /encrypt|password/i.test(error.message)) {
    return '這份 PDF 需要開啟密碼，目前無法直接處理。'
  }
  return error instanceof Error ? error.message : '處理檔案時發生錯誤。'
}

function DropZone({
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

function SortableFileRow({
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

function MergeWorkspace() {
  const [items, setItems] = useState<MergeItem[]>([])
  const [outputName, setOutputName] = useState('merged.pdf')
  const [message, setMessage] = useState('')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function addFiles(files: File[]) {
    if (processing || files.length === 0) return
    const valid = files.filter((file) => /\.pdf$/i.test(file.name))
    if (valid.length !== files.length) setMessage('已略過非 PDF 檔案。')
    else setMessage('')
    const added = valid.map((file): MergeItem => ({ id: crypto.randomUUID(), file, loading: true }))
    setItems((current) => [...current, ...added])
    for (const item of added) {
      try {
        const info = await inspectPdf(item.file)
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...info, loading: false } : entry))
      } catch (error) {
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, error: fileError(error), loading: false } : entry))
      }
    }
  }

  function moveItem(index: number, direction: -1 | 1) {
    setItems((current) => arrayMove(current, index, index + direction))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setItems((current) => {
      const from = current.findIndex((item) => item.id === active.id)
      const to = current.findIndex((item) => item.id === over.id)
      return from < 0 || to < 0 ? current : arrayMove(current, from, to)
    })
  }

  async function handleMerge() {
    if (processing || items.length < 2 || items.some((item) => item.loading || item.error)) return
    setMessage('')
    setProgress(0)
    setProcessing(true)
    try {
      const blob = await mergePdfs(items.map((item) => item.file), setProgress)
      saveBlob(blob, `${fileStem(outputName)}.pdf`)
      setMessage(`合併完成，已下載 ${formatBytes(blob.size)} 的 PDF。`)
    } catch (error) {
      setMessage(fileError(error))
    } finally {
      setProcessing(false)
    }
  }

  const totalPages = items.reduce((sum, item) => sum + (item.pageCount ?? 0), 0)
  const canMerge = items.length >= 2 && items.every((item) => !item.loading && !item.error)
  const fileLabel = (id: string | number) => items.find((item) => item.id === id)?.file.name ?? '檔案'

  return (
    <div className="workspace-grid">
      <section className="workspace-card workspace-main" aria-labelledby="merge-heading">
        <div className="card-header">
          <div>
            <div className="eyebrow">01 / 排列檔案</div>
            <h2 id="merge-heading">依你想要的順序合併</h2>
            <p>拖曳右側把手，或用上下按鈕調整 PDF 順序。</p>
          </div>
          {items.length > 0 && <span className="count-badge">{items.length} 份檔案</span>}
        </div>
        {items.length === 0 ? (
          <DropZone multiple onFiles={addFiles} />
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              accessibility={{
                screenReaderInstructions: { draggable: '按空白鍵開始排序，使用方向鍵移動，再按空白鍵放下。' },
                announcements: {
                  onDragStart: ({ active }) => `開始移動 ${fileLabel(active.id)}。`,
                  onDragOver: ({ active, over }) => over ? `${fileLabel(active.id)} 移到 ${fileLabel(over.id)} 的位置。` : undefined,
                  onDragEnd: ({ active, over }) => over ? `${fileLabel(active.id)} 已放到 ${fileLabel(over.id)} 的位置。` : '已取消排序。',
                  onDragCancel: () => '已取消排序。',
                },
              }}
            >
              <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <div className="file-list">
                  {items.map((item, index) => (
                    <SortableFileRow
                      key={item.id}
                      item={item}
                      position={index}
                      total={items.length}
                      disabled={processing}
                      onMove={(direction) => moveItem(index, direction)}
                      onRemove={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {!processing && <DropZone multiple compact onFiles={addFiles} />}
          </>
        )}
        <div className="privacy-note"><LockKeyhole size={16} /> 檔案只在你的瀏覽器中處理，不會上傳。</div>
      </section>

      <aside className="workspace-card output-card" aria-labelledby="merge-output-heading">
        <div className="eyebrow">02 / 匯出結果</div>
        <h2 id="merge-output-heading">準備好輸出？</h2>
        <p>合併後會得到一份 PDF，頁面依左側檔案順序排列。</p>
        <div className="output-stats">
          <div><span>PDF 檔案</span><strong>{items.length} 份</strong></div>
          <div><span>合計頁數</span><strong>{totalPages} 頁</strong></div>
          <div><span>原始大小</span><strong>{formatBytes(items.reduce((sum, item) => sum + item.file.size, 0))}</strong></div>
        </div>
        <label className="field-label" htmlFor="merge-name">輸出檔名</label>
        <div className="filename-field">
          <input id="merge-name" value={outputName.replace(/\.pdf$/i, '')} onChange={(event) => setOutputName(event.target.value)} placeholder="merged" />
          <span>.pdf</span>
        </div>
        <button className="button button--accent button--full" disabled={!canMerge || processing} onClick={handleMerge}>
          <Download size={18} />
          {processing ? `處理中 ${progress}/${items.length}` : '合併並下載 PDF'}
          {!processing && <ArrowRight size={17} />}
        </button>
        <p className="encryption-note">若原檔只有編輯權限限制，輸出檔不會保留原加密設定。</p>
        {!canMerge && <p className="helper-text">請加入至少兩份有效的 PDF。</p>}
        {message && <p className={`status-message ${message.includes('完成') ? 'status-message--success' : ''}`} role="status">{message}</p>}
      </aside>
    </div>
  )
}

function PageThumbnail({
  pdf,
  pageNumber,
  selected,
  disabled,
  groupCount,
  onToggle,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  selected: boolean
  disabled: boolean
  groupCount: number
  onToggle: () => void
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(false)
  const [image, setImage] = useState<string>()

  useEffect(() => {
    const element = anchorRef.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '300px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setImage(undefined)
    renderPageThumbnail(pdf, pageNumber, 156)
      .then((result) => { if (!cancelled) setImage(result) })
      .catch(() => { if (!cancelled) setImage(undefined) })
    return () => { cancelled = true }
  }, [pdf, pageNumber, visible])

  return (
    <button ref={anchorRef} className={`page-tile ${selected ? 'page-tile--selected' : ''}`} onClick={onToggle} disabled={disabled} aria-pressed={selected} aria-label={`第 ${pageNumber} 頁${selected ? '，已選取' : ''}`}>
      <div className="page-image">
        {image ? <img src={image} alt="" /> : <div className="page-skeleton"><Files size={22} /></div>}
        <span className="selection-mark"><Check size={15} strokeWidth={3} /></span>
      </div>
      <div className="page-caption"><strong>第 {pageNumber} 頁</strong>{groupCount > 0 && <span>已加入 {groupCount} 組</span>}</div>
    </button>
  )
}

function SplitWorkspace() {
  const [file, setFile] = useState<File | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [mode, setMode] = useState<'custom' | 'every'>('custom')
  const [selected, setSelected] = useState<number[]>([])
  const [rangeInput, setRangeInput] = useState('')
  const [groups, setGroups] = useState<PageGroup[]>([])
  const [message, setMessage] = useState('')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null)

  useEffect(() => {
    if (!file) { setPdf(null); return }
    let cancelled = false
    setLoading(true)
    setLoadError('')
    setPdf(null)
    openPdf(file)
      .then((task) => {
        if (cancelled) { void task.destroy(); return }
        taskRef.current = task
        return task.promise
      })
      .then((document) => {
        if (document && !cancelled) setPdf(document)
      })
      .catch((error) => { if (!cancelled) setLoadError(fileError(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
      if (taskRef.current) void taskRef.current.destroy()
      taskRef.current = null
    }
  }, [file])

  function chooseFile(files: File[]) {
    if (processing || files.length === 0) return
    const candidate = files[0]
    if (!/\.pdf$/i.test(candidate.name)) { setMessage('請選擇 PDF 檔案。'); return }
    setFile(candidate)
    setSelected([])
    setGroups([])
    setRangeInput('')
    setMessage('')
  }

  function togglePage(page: number) {
    setSelected((current) => current.includes(page) ? current.filter((entry) => entry !== page) : [...current, page].sort((a, b) => a - b))
  }

  function applyRange() {
    if (!pdf) return
    try {
      setSelected(parsePageRange(rangeInput, pdf.numPages))
      setMessage('')
    } catch (error) {
      setMessage(fileError(error))
    }
  }

  function addGroup() {
    if (selected.length === 0) return
    setGroups((current) => [...current, { id: crypto.randomUUID(), name: `部分 ${current.length + 1}`, pages: selected }])
    setSelected([])
    setRangeInput('')
    setMessage('')
  }

  async function handleExport() {
    if (!file || !pdf || processing) return
    const exportGroups = mode === 'every'
      ? Array.from({ length: pdf.numPages }, (_, index): PageGroup => ({ id: `${index + 1}`, name: `page-${String(index + 1).padStart(String(pdf.numPages).length, '0')}`, pages: [index + 1] }))
      : groups
    if (exportGroups.length === 0) return
    setProcessing(true)
    setProgress(0)
    setMessage('')
    try {
      const result = await splitPdf(file, exportGroups, setProgress)
      saveBlob(result.blob, result.filename)
      setMessage(`完成！已下載 ${result.fileCount} 份 PDF${result.fileCount > 1 ? '（ZIP）' : ''}。`)
    } catch (error) {
      setMessage(fileError(error))
    } finally {
      setProcessing(false)
    }
  }

  const pages = pdf ? Array.from({ length: pdf.numPages }, (_, index) => index + 1) : []
  const outputCount = mode === 'every' ? (pdf?.numPages ?? 0) : groups.length

  return (
    <div className="workspace-grid">
      <section className="workspace-card workspace-main" aria-labelledby="split-heading">
        <div className="card-header">
          <div>
            <div className="eyebrow">01 / 選擇頁面</div>
            <h2 id="split-heading">把需要的頁面留下來</h2>
            <p>點選頁面組成新檔案，或直接將每頁分開。</p>
          </div>
          {pdf && <span className="count-badge">{pdf.numPages} 頁</span>}
        </div>
        {!file ? (
          <DropZone multiple={false} onFiles={chooseFile} />
        ) : (
          <>
            <div className="source-file">
              <div className="source-file-icon"><Files size={22} /></div>
              <div><strong>{file.name}</strong><span>{formatBytes(file.size)}{pdf ? ` · ${pdf.numPages} 頁` : ''}</span></div>
              <button className="button button--small button--outline" onClick={() => setFile(null)} disabled={processing}>更換</button>
            </div>
            {loading && <div className="loading-panel">正在讀取頁面…</div>}
            {loadError && <p className="status-message" role="alert">{loadError}</p>}
            {pdf && (
              <>
                <div className="mode-switch" role="group" aria-label="拆分方式">
                  <button className={mode === 'custom' ? 'active' : ''} onClick={() => { setMode('custom'); setMessage('') }} aria-pressed={mode === 'custom'}><Scissors size={17} /> 自選頁面</button>
                  <button className={mode === 'every' ? 'active' : ''} onClick={() => { setMode('every'); setMessage('') }} aria-pressed={mode === 'every'}><FileStack size={17} /> 每頁一檔</button>
                </div>
                {mode === 'custom' && (
                  <div className="page-tools">
                    <div className="range-form">
                      <label htmlFor="page-range">快速選取頁碼</label>
                      <div>
                        <input
                          id="page-range"
                          value={rangeInput}
                          onChange={(event) => setRangeInput(event.target.value)}
                          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') applyRange() }}
                          placeholder="例如 1-3, 5, 8"
                        />
                        <button className="button button--small button--dark" onClick={applyRange}>套用</button>
                      </div>
                    </div>
                    <div className="selection-actions">
                      <span>已選 {selected.length} 頁</span>
                      <button onClick={() => setSelected(pages)}>全選</button>
                      <button onClick={() => setSelected([])}>清除</button>
                    </div>
                  </div>
                )}
                <div className={`page-grid ${mode === 'every' ? 'page-grid--readonly' : ''}`}>
                  {pages.map((pageNumber) => (
                    <PageThumbnail
                      key={`${file.name}-${pageNumber}`}
                      pdf={pdf}
                      pageNumber={pageNumber}
                      selected={mode === 'every' || selected.includes(pageNumber)}
                      disabled={mode === 'every'}
                      groupCount={mode === 'custom' ? groups.filter((group) => group.pages.includes(pageNumber)).length : 0}
                      onToggle={() => { if (mode === 'custom') togglePage(pageNumber) }}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className="privacy-note"><LockKeyhole size={16} /> 檔案只在你的瀏覽器中處理，不會上傳。</div>
      </section>

      <aside className="workspace-card output-card" aria-labelledby="split-output-heading">
        <div className="eyebrow">02 / 建立檔案</div>
        <h2 id="split-output-heading">輸出清單</h2>
        <p>{mode === 'custom' ? '選好頁面後加入一組；每組會成為一份 PDF。' : '原檔每一頁會各自成為一份 PDF。'}</p>
        {mode === 'custom' ? (
          <>
            <button className="button button--dark button--full add-group" onClick={addGroup} disabled={selected.length === 0 || processing}>
              <Plus size={18} /> 將 {selected.length} 頁加入新檔案
            </button>
            <div className="group-list">
              {groups.length === 0 ? (
                <div className="empty-groups"><FileStack size={25} /><strong>尚無輸出檔案</strong><span>從左側選頁，再加入新檔案。</span></div>
              ) : groups.map((group, index) => (
                <div className="group-card" key={group.id}>
                  <div className="group-number">{String(index + 1).padStart(2, '0')}</div>
                  <div className="group-details">
                    <input
                      value={group.name}
                      onChange={(event) => setGroups((current) => current.map((entry) => entry.id === group.id ? { ...entry, name: event.target.value } : entry))}
                      aria-label={`第 ${index + 1} 份檔案名稱`}
                    />
                    <span>{group.pages.length} 頁 · {group.pages.join(', ')}</span>
                  </div>
                  <button className="icon-button icon-button--danger" onClick={() => setGroups((current) => current.filter((entry) => entry.id !== group.id))} disabled={processing} aria-label={`移除 ${group.name}`}><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="every-summary"><CheckCheck size={24} /><div><strong>{pdf ? `${pdf.numPages} 份獨立 PDF` : '等待匯入 PDF'}</strong><span>多個檔案會打包為 ZIP 下載。</span></div></div>
        )}
        <div className="output-divider" />
        <div className="output-count"><span>準備輸出</span><strong>{outputCount} 份 PDF</strong></div>
        <button className="button button--accent button--full" disabled={!pdf || outputCount === 0 || processing} onClick={handleExport}>
          <Download size={18} />
          {processing ? `處理中 ${progress}/${outputCount}` : outputCount > 1 ? '下載 ZIP 檔' : '下載 PDF'}
          {!processing && <ArrowRight size={17} />}
        </button>
        <p className="encryption-note">若原檔只有編輯權限限制，輸出檔不會保留原加密設定。</p>
        {message && <p className={`status-message ${message.includes('完成') ? 'status-message--success' : ''}`} role="status">{message}</p>}
      </aside>
    </div>
  )
}

export default function App() {
  const [tool, setTool] = useState<Tool>('merge')

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="Folio PDF 工作台"><div className="brand-mark"><span /></div><span>folio<span className="brand-dot">.</span></span></div>
        <div className="header-right"><span className="header-caption">PDF 工作台</span><span className="header-privacy"><LockKeyhole size={14} /> 本機處理・無需上傳</span></div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <div className="hero-kicker"><span className="kicker-line" /> YOUR PDF, YOUR WAY</div>
            <h1>PDF 整理，<br /><em>剛剛好。</em></h1>
            <p>合併需要的，拆出想留下的。<br />簡單幾步，讓檔案回到你的節奏。</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit art-orbit--one" />
            <div className="art-orbit art-orbit--two" />
            <div className="art-sheet art-sheet--back"><span /><span /><span /></div>
            <div className="art-sheet art-sheet--middle"><span /><span /><span /></div>
            <div className="art-sheet art-sheet--front"><div className="art-pdf">PDF</div><span /><span /><span /></div>
            <div className="art-spark art-spark--one">✳</div><div className="art-spark art-spark--two">✳</div>
          </div>
        </section>

        <nav className="tool-nav" aria-label="PDF 工具">
          <button className={tool === 'merge' ? 'tool-tab active' : 'tool-tab'} onClick={() => setTool('merge')} aria-current={tool === 'merge' ? 'page' : undefined}>
            <div className="tool-tab-icon"><Files size={20} strokeWidth={1.8} /></div>
            <span><strong>合併 PDF</strong><small>把多份整理成一份</small></span>
            <ArrowRight size={18} className="tool-tab-arrow" />
          </button>
          <button className={tool === 'split' ? 'tool-tab active' : 'tool-tab'} onClick={() => setTool('split')} aria-current={tool === 'split' ? 'page' : undefined}>
            <div className="tool-tab-icon"><Scissors size={20} strokeWidth={1.8} /></div>
            <span><strong>拆分 PDF</strong><small>取出真正需要的頁面</small></span>
            <ArrowRight size={18} className="tool-tab-arrow" />
          </button>
        </nav>
        <div className="workspace" key={tool}>{tool === 'merge' ? <MergeWorkspace /> : <SplitWorkspace />}</div>
      </main>
      <footer className="site-footer"><span>folio. / 在瀏覽器裡，安心整理 PDF。</span><span>MADE FOR THE LITTLE DETAILS <Check size={14} /></span></footer>
    </div>
  )
}
