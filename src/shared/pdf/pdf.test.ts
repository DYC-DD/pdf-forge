import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'
import { mergePdfs, parsePageRange, splitPdf } from './pdf'
import restrictedPdfBase64 from './__fixtures__/empty-user-password.base64?raw'
import { unlockPdfWithEmptyPassword } from './unlockPdf'

async function makePdf(name: string, widths: number[]): Promise<File> {
  const doc = await PDFDocument.create()
  for (const width of widths) doc.addPage([width, 200])
  return new File([new Uint8Array(await doc.save())], name, { type: 'application/pdf' })
}

describe('page range', () => {
  it('accepts mixed ranges, removes duplicates, and keeps source order', () => {
    expect(parsePageRange('5, 1-3, 3，8', 8)).toEqual([1, 2, 3, 5, 8])
  })

  it('rejects invalid or out-of-bounds pages', () => {
    expect(() => parsePageRange('0, 2', 5)).toThrow()
    expect(() => parsePageRange('4-8', 5)).toThrow()
    expect(() => parsePageRange('3-1', 5)).toThrow()
    expect(() => parsePageRange('1,,3', 5)).toThrow()
  })
})

describe('PDF output', () => {
  it('merges files in the supplied order and retains their pages', async () => {
    const first = await makePdf('first.pdf', [101, 102])
    const second = await makePdf('second.pdf', [201])
    const blob = await mergePdfs([second, first])
    const result = await PDFDocument.load(await blob.arrayBuffer())
    expect(result.getPages().map((page) => page.getWidth())).toEqual([201, 101, 102])
  })

  it('creates arbitrary page groups as separate PDFs in a ZIP', async () => {
    const source = await makePdf('source.pdf', [101, 102, 103])
    const output = await splitPdf(source, [
      { id: 'a', name: 'chosen', pages: [1, 3] },
      { id: 'b', name: 'other', pages: [2] },
    ])
    expect(output.filename).toBe('source-split.zip')
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer())
    const chosen = await PDFDocument.load(await zip.file('source-chosen.pdf')!.async('uint8array'))
    const other = await PDFDocument.load(await zip.file('source-other.pdf')!.async('uint8array'))
    expect(chosen.getPages().map((page) => page.getWidth())).toEqual([101, 103])
    expect(other.getPages().map((page) => page.getWidth())).toEqual([102])
  })

  it('downloads a single selected group as a PDF', async () => {
    const source = await makePdf('source.pdf', [101, 102])
    const output = await splitPdf(source, [{ id: 'a', name: 'selected', pages: [2] }])
    expect(output.filename).toBe('source-selected.pdf')
    expect(output.blob.type).toBe('application/pdf')
    const result = await PDFDocument.load(await output.blob.arrayBuffer())
    expect(result.getPages().map((page) => page.getWidth())).toEqual([102])
  })

  it('splits a PDF whose editing is restricted by an owner password', async () => {
    const bytes = Uint8Array.from(atob(restrictedPdfBase64), (character) => character.charCodeAt(0))
    const restricted = new File([bytes], 'restricted.pdf', { type: 'application/pdf' })
    await unlockPdfWithEmptyPassword(
      restricted,
      new URL('../../../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url).pathname,
    )
    const output = await splitPdf(restricted, [{ id: 'a', name: 'page-1', pages: [1] }])
    const result = await PDFDocument.load(await output.blob.arrayBuffer())
    expect(result.getPageCount()).toBe(1)
    expect(result.isEncrypted).toBe(false)
  })
})
