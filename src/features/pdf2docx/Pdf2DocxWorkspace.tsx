import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";

import { fileStem, formatBytes, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { pdfPageCountError } from "../../shared/pdf/limits";
import { openPdf } from "../../shared/pdf/preview";
import Counter from "../../shared/ui/Counter";
import DropZone from "../../shared/ui/DropZone";
import PdfPageThumbnail from "../../shared/ui/PdfPageThumbnail";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import useViewMode from "../../shared/ui/useViewMode";
import ViewModeToggle from "../../shared/ui/ViewModeToggle";
import { parsePageRange } from "../split/lib/parsePageRange";
import { analyzePdf } from "./lib/analyzePdf";
import { DOCX_LIMITS, docxInputError } from "./lib/limits";
import { runDocxExport } from "./lib/runDocxJob";
import type { ConversionProgress, DocumentModel } from "./types";

export default function Pdf2DocxWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [viewMode, setViewMode] = useViewMode();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [rangeInput, setRangeInput] = useState("");
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [progress, setProgress] = useState<ConversionProgress | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setLoading(true);
    openPdf(file, DOCX_LIMITS.renderPixels)
      .then(async (opened) => {
        if (cancelled) {
          await opened.destroy();
          return;
        }
        task = opened;
        const source = await opened.promise;
        const error = pdfPageCountError(source.numPages);
        if (error) throw new Error(error);
        if (!cancelled) {
          setPdf(source);
          setSelected(Array.from({ length: source.numPages }, (_, i) => i + 1));
        }
      })
      .catch((error) => {
        if (task) {
          void task.destroy();
          task = undefined;
        }
        if (!cancelled) setMessage(fileError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (task) void task.destroy();
    };
  }, [file]);

  function invalidate() {
    setModel(null);
    setMessage("");
    setSuccess(false);
  }
  function clear() {
    if (controllerRef.current) return;
    setFile(null);
    setPdf(null);
    setLoading(false);
    setSelected([]);
    setRangeInput("");
    setPreviewPage(null);
    invalidate();
  }
  function acceptFiles(files: File[]) {
    if (controllerRef.current || loading) return;
    setSuccess(false);
    if (files.length !== 1) {
      setMessage("一次請選擇一份 PDF。");
      return;
    }
    const error = docxInputError(files[0]);
    if (error) {
      setMessage(error);
      return;
    }
    setPdf(null);
    setFile(files[0]);
    setSelected([]);
    setRangeInput("");
    setPreviewPage(null);
    invalidate();
  }

  function selectPages(pages: number[]) {
    if (!pdf || controllerRef.current) return;
    setSelected(pages);
    invalidate();
  }

  function togglePage(page: number) {
    selectPages(
      selected.includes(page)
        ? selected.filter((entry) => entry !== page)
        : [...selected, page].sort((a, b) => a - b)
    );
  }

  function applyRange() {
    if (!pdf || controllerRef.current) return;
    try {
      selectPages(parsePageRange(rangeInput, pdf.numPages));
    } catch (error) {
      setMessage(fileError(error));
      setSuccess(false);
    }
  }

  async function analyze() {
    if (!file || !pdf || !selected.length || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    invalidate();
    setProgress({ stage: "read", page: selected[0], total: selected.length });
    try {
      const result = await analyzePdf(file, selected, {
        signal: controller.signal,
        onProgress: (value) => {
          if (
            mountedRef.current &&
            controllerRef.current === controller &&
            !controller.signal.aborted
          )
            setProgress(value);
        },
      });
      if (mountedRef.current && !controller.signal.aborted) {
        setModel(result);
      }
    } catch (error) {
      if (mountedRef.current)
        setMessage(
          controller.signal.aborted ? "已取消分析。" : fileError(error)
        );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current) setProgress(null);
    }
  }

  async function download() {
    if (!file || !model || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setMessage("");
    setSuccess(false);
    setProgress({ stage: "export", page: 0, total: model.pages.length });
    try {
      const blob = await runDocxExport(
        model,
        { preservePageBreaks: true },
        controller.signal
      );
      if (mountedRef.current && !controller.signal.aborted) {
        saveBlob(blob, `${fileStem(file.name)}.docx`);
        setMessage("已產生 Word 檔案，請開啟後核對內容與排版。");
        setSuccess(true);
      }
    } catch (error) {
      if (mountedRef.current)
        setMessage(
          controller.signal.aborted ? "已取消產生 Word。" : fileError(error)
        );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current) setProgress(null);
    }
  }

  const busy = !!progress;
  const pages = useMemo(
    () => Array.from({ length: pdf?.numPages ?? 0 }, (_, i) => i + 1),
    [pdf]
  );
  const selectedPages = useMemo(() => new Set(selected), [selected]);
  const blocked =
    model?.issues.some((issue) => issue.severity === "error") ||
    (!model?.stats.characters && !model?.stats.images);
  const reviewCount = new Set(
    model?.issues
      .filter((issue) => issue.severity === "review")
      .map((issue) => issue.page)
  ).size;
  const progressText =
    progress?.stage === "export"
      ? "正在建立 Word…"
      : progress?.stage === "layout"
        ? "正在重建段落與版面結構…"
        : progress
          ? `正在${progress.stage === "ocr" ? "辨識" : "讀取"}原稿第 ${progress.page} 頁${progress.detail ? `・${progress.detail}` : ""}`
          : "";

  return (
    <div className="workspace-grid pdf2docx-workspace">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="pdf2docx-heading"
      >
        <div className="card-header file-card-header">
          <div>
            <div className="eyebrow">01 / {file ? "選擇頁面" : "加入 PDF"}</div>
            <h2 id="pdf2docx-heading">
              {file ? "選擇要轉成 Word 的頁面" : "加入要轉換的文件"}
            </h2>
            <p>選取要轉換的頁面，點眼睛圖示可放大預覽。</p>
          </div>
          {file && (
            <div className="file-list-actions">
              <div className="file-list-action-buttons">
                <button
                  type="button"
                  className="clear-files-button"
                  onClick={clear}
                  disabled={busy}
                  aria-label="清除 PDF"
                >
                  <PublicIcon name="trash" size={15} />
                  清除
                </button>
                <ViewModeToggle
                  value={viewMode}
                  onChange={setViewMode}
                  disabled={busy}
                />
              </div>
            </div>
          )}
        </div>
        {!file ? (
          <DropZone
            multiple={false}
            onFiles={acceptFiles}
            label="選擇要轉成 Word 的 PDF"
            description="一份 PDF，最多 32 MB；檔案留在你的裝置"
          />
        ) : (
          <>
            <div className="source-file pdf2docx-source">
              <div className="source-file-icon">
                <PublicIcon name="file-type-pdf" size={22} />
              </div>
              <div>
                <strong title={file.name}>{file.name}</strong>
                <span>
                  {formatBytes(file.size)}
                  {pdf && ` · ${pdf.numPages} 頁`}
                </span>
              </div>
              {pdf && (
                <button
                  type="button"
                  className="button button--outline button--small"
                  onClick={() => setPreviewPage(1)}
                >
                  <PublicIcon name="eye" size={16} />
                  原稿預覽
                </button>
              )}
            </div>
            {pdf && (
              <>
                <div className="split-toolbar split-toolbar--custom">
                  <div className="range-form">
                    <div>
                      <TextField
                        id="pdf2docx-page-range"
                        className="page-range-field"
                        label="快速選取頁碼"
                        size="small"
                        slotProps={{ inputLabel: { shrink: true } }}
                        value={rangeInput}
                        onChange={(event) => setRangeInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") applyRange();
                        }}
                        disabled={busy}
                        placeholder="例如 1-3, 5, 8"
                      />
                      <button
                        type="button"
                        className="button button--small button--dark"
                        onClick={applyRange}
                        disabled={busy}
                      >
                        套用
                      </button>
                    </div>
                  </div>
                  <div className="selection-actions">
                    <span>
                      已選 <Counter value={selected.length} /> 頁
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => selectPages(pages)}
                    >
                      全選
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => selectPages([])}
                    >
                      清除
                    </button>
                  </div>
                </div>
                <div className={`pdf-collection pdf-collection--${viewMode}`}>
                  {pages.map((pageNumber) => (
                    <PdfPageThumbnail
                      key={pageNumber}
                      pdf={pdf}
                      pageNumber={pageNumber}
                      viewMode={viewMode}
                      selected={selectedPages.has(pageNumber)}
                      disabled={busy}
                      onToggle={() => togglePage(pageNumber)}
                      onPreview={() => setPreviewPage(pageNumber)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {(loading || busy) && (
          <div className="pdf2docx-progress" role="status" aria-busy="true">
            <CircularProgress
              className="workspace-loading-spinner"
              color="inherit"
              size={40}
              aria-label={loading ? "正在開啟 PDF" : "文件處理中"}
            />
            <strong>{loading ? "正在開啟 PDF…" : progressText}</strong>
            {busy && <span>全部在本機處理，共 {progress?.total} 頁。</span>}
          </div>
        )}
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />
          PDF、文字與圖片只在瀏覽器中處理，不會上傳。
        </div>
      </section>
      <aside
        className="workspace-card output-card convert-output-card pdf2docx-output"
        aria-labelledby="pdf2docx-output-heading"
      >
        <div className="eyebrow">02 / Word 輸出</div>
        <h2 id="pdf2docx-output-heading">建立 Word 文件</h2>
        <p>所選頁面依原稿順序合併成一份 Word。</p>
        {pdf && (
          <p className="pdf2docx-result-note" role="status">
            {selected.length
              ? `已選 ${selected.length} / ${pdf.numPages} 頁，掃描完成後即可下載。`
              : "請先從左側選取至少一頁。"}
          </p>
        )}
        <button
          type="button"
          className="button button--dark button--full"
          disabled={!pdf || !selected.length || loading || busy}
          onClick={() => void analyze()}
        >
          <PublicIcon name="zoom-scan" size={18} />
          {model ? "重新掃描文件內容" : "掃描文件內容"}
        </button>
        <div className="output-divider" />
        {file && (
          <p
            className="pdf2docx-filename"
            title={`${fileStem(file.name)}.docx`}
          >
            {fileStem(file.name)}.docx
          </p>
        )}
        {model && (
          <p className="pdf2docx-result-note">
            {blocked
              ? "有頁面未能完整讀取，請重新掃描文件內容。"
              : reviewCount
                ? `已掃描所選 ${model.stats.pages} 頁；${reviewCount} 頁需核對，下載 Word 後請對照原稿檢查。`
                : `已掃描所選 ${model.stats.pages} 頁，可以下載 Word。`}
          </p>
        )}
        {model && !blocked && (
          <p className="pdf2docx-result-note">
            {`可編輯文字 ${model.stats.characters.toLocaleString()} 字元 · Word 表格 ${model.stats.tables} 個`}
          </p>
        )}
        <button
          type="button"
          className="button button--accent button--full"
          onClick={() => void download()}
          disabled={!model || blocked || busy}
        >
          <PublicIcon name="download" size={18} />
          下載 Word
        </button>
        {busy && (
          <button
            type="button"
            className="button button--outline button--full operation-cancel"
            onClick={() => controllerRef.current?.abort()}
          >
            取消處理
          </button>
        )}
        {message && (
          <p
            className={`status-message ${success ? "status-message--success" : ""}`}
            role={success ? "status" : "alert"}
          >
            {message}
          </p>
        )}
        <p className="encryption-note">
          辨識可靠的文字與表格可編輯；浮水印重疊或難辨識的區塊保留原圖，依原稿安排分頁。
        </p>
      </aside>
      {file && pdf && previewPage !== null && (
        <PdfPreviewDialog
          file={file}
          pdf={pdf}
          initialPage={previewPage}
          maxImagePixels={DOCX_LIMITS.renderPixels}
          onClose={() => setPreviewPage(null)}
        />
      )}
    </div>
  );
}
