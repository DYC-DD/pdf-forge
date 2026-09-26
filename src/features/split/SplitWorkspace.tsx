import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, CheckCheck, Download, FileStack, Files, LockKeyhole, Plus, Scissors, Trash2 } from 'lucide-react'
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from 'pdfjs-dist'
import DropZone from '../../shared/components/DropZone'
import { fileError } from '../../shared/pdf/errors'
import { formatBytes, parsePageRange, saveBlob, splitPdf, type PageGroup } from '../../shared/pdf/pdf'
import { openPdf } from '../../shared/pdf/preview'
import PageThumbnail from './PageThumbnail'

export default function SplitWorkspace() {
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
