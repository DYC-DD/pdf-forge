export type PageGroup = {
  id: string
  name: string
  pages: number[] // One-based page numbers in source order.
}

export type SplitOutput = {
  blob: Blob
  filename: string
  fileCount: number
}

export function fileStem(filename: string): string {
  return filename.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'document'
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function parsePageRange(input: string, pageCount: number): number[] {
  const parts = input.split(/[,，、]/).map((part) => part.trim())
  if (!input.trim() || parts.some((part) => !part)) {
    throw new Error('請輸入頁碼，例如 1-3, 5, 8。')
  }

  const selected = new Set<number>()
  for (const part of parts) {
    const match = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part)
    if (!match) throw new Error(`無法辨識「${part}」，請使用頁碼或起訖範圍。`)
    const first = Number(match[1])
    const last = match[2] ? Number(match[2]) : first
    if (first < 1 || last > pageCount || first > last) {
      throw new Error(`「${part}」超出範圍，這份 PDF 共有 ${pageCount} 頁。`)
    }
    for (let page = first; page <= last; page += 1) selected.add(page)
  }
  return [...selected].sort((a, b) => a - b)
}

export async function mergePdfs(files: File[], onProgress?: (done: number) => void): Promise<Blob> {
  if (files.length < 2) throw new Error('請至少加入兩份 PDF。')
  const { PDFDocument } = await import('pdf-lib')
  const output = await PDFDocument.create()
  for (let index = 0; index < files.length; index += 1) {
    const source = await PDFDocument.load(await files[index].arrayBuffer())
    const pages = await output.copyPages(source, source.getPageIndices())
    for (const page of pages) output.addPage(page)
    onProgress?.(index + 1)
  }
  return new Blob([new Uint8Array(await output.save())], { type: 'application/pdf' })
}

export async function splitPdf(
  file: File,
  groups: PageGroup[],
  onProgress?: (done: number) => void,
): Promise<SplitOutput> {
  if (groups.length === 0) throw new Error('請先選擇至少一組頁面。')
  const [{ PDFDocument }, { default: JSZip }] = await Promise.all([import('pdf-lib'), import('jszip')])
  const source = await PDFDocument.load(await file.arrayBuffer())
  const stem = fileStem(file.name)
  const zip = new JSZip()
  const usedNames = new Set<string>()
  let singlePdf: Uint8Array | undefined

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    if (group.pages.length === 0 || group.pages.some((page) => page < 1 || page > source.getPageCount())) {
      throw new Error(`「${group.name}」的頁碼不正確。`)
    }
    const output = await PDFDocument.create()
    const pages = await output.copyPages(source, group.pages.map((page) => page - 1))
    for (const page of pages) output.addPage(page)
    const bytes = new Uint8Array(await output.save())
    const label = fileStem(group.name) || `part-${index + 1}`
    let name = `${stem}-${label}.pdf`
    let suffix = 2
    while (usedNames.has(name.toLowerCase())) {
      name = `${stem}-${label}-${suffix}.pdf`
      suffix += 1
    }
    usedNames.add(name.toLowerCase())
    if (groups.length === 1) singlePdf = bytes
    else zip.file(name, bytes)
    onProgress?.(index + 1)
  }

  if (singlePdf) {
    return {
      blob: new Blob([new Uint8Array(singlePdf)], { type: 'application/pdf' }),
      filename: [...usedNames][0],
      fileCount: 1,
    }
  }
  return {
    blob: await zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }),
    filename: `${stem}-split.zip`,
    fileCount: groups.length,
  }
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
