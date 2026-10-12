import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { fileStem, formatBytes, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { pdfPageCountError } from "../../shared/pdf/limits";
import { openPdf } from "../../shared/pdf/preview";
import DropZone from "../../shared/ui/DropZone";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import { analyzePdf } from "./lib/analyzePdf";
import { DOCX_LIMITS, docxInputError } from "./lib/limits";
import { runDocxExport } from "./lib/runDocxJob";
import StructurePreview from "./StructurePreview";
import type { ConversionProgress, DocumentModel } from "./types";

export default function Pdf2DocxWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
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
        if (!cancelled) setPdf(source);
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
    invalidate();
  }

  async function analyze() {
    if (!file || !pdf || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    invalidate();
    setProgress({ stage: "read", page: 1, total: pdf.numPages });
    try {
      const result = await analyzePdf(file, undefined, {
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
        setPageIndex(0);
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
  const blocked =
    model?.issues.some((issue) => issue.severity === "error") ||
    (!model?.stats.characters && !model?.stats.images);
  const reviewCount = new Set(
    model?.issues
      .filter((issue) => issue.severity === "review")
      .map((issue) => issue.page)
  ).size;
  const currentPage = model?.pages[pageIndex];
  const currentIssues =
    model?.issues.filter((issue) => issue.page === currentPage?.number) ?? [];
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
        <div className="card-header">
          <div>
            <div className="eyebrow">01 / 加入 PDF</div>
            <h2 id="pdf2docx-heading">加入要轉換的文件</h2>
            <p>掃描整份文件，自動處理文字、圖片與原稿分頁。</p>
          </div>
          {file && (
            <button
              className="clear-files-button"
              onClick={clear}
              disabled={busy}
            >
              <PublicIcon name="trash" size={15} />
              清除
            </button>
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
                  onClick={() => setPreviewPage(currentPage?.number ?? 1)}
                >
                  <PublicIcon name="eye" size={16} />
                  原稿預覽
                </button>
              )}
            </div>
            {loading && (
              <div className="loading-panel" role="status">
                正在開啟 PDF…
              </div>
            )}
            {!model && !busy && (
              <div className="pdf2docx-empty">
                <PublicIcon name="list" size={26} />
                <strong>準備好後，掃描文件內容</strong>
                <p>自動掃描全部頁面，完成後即可下載 Word。</p>
              </div>
            )}
          </>
        )}
        {busy && (
          <div className="pdf2docx-progress" role="status">
            <progress aria-label="文件處理中" />
            <strong>{progressText}</strong>
            <span>全部在本機處理，共 {progress?.total} 頁。</span>
          </div>
        )}
        {model && currentPage && (
          <details className="pdf2docx-analysis">
            <summary>查看掃描結果 · 共 {model.stats.pages} 頁</summary>
            <dl className="pdf2docx-stats">
              <div>
                <dt>可編輯字元</dt>
                <dd>{model.stats.characters.toLocaleString()}</dd>
              </div>
              <div>
                <dt>段落</dt>
                <dd>{model.stats.paragraphs}</dd>
              </div>
              <div>
                <dt>表格</dt>
                <dd>{model.stats.tables}</dd>
              </div>
              <div>
                <dt>圖片</dt>
                <dd>{model.stats.images}</dd>
              </div>
              <div>
                <dt>獨立線條</dt>
                <dd>{model.stats.rules ?? 0}</dd>
              </div>
              <div>
                <dt>OCR 頁數</dt>
                <dd>{model.stats.ocrPages}</dd>
              </div>
            </dl>
            <div className="pdf2docx-page-picker">
              <DocxSelectField<number>
                id="pdf2docx-page"
                label="檢查原稿頁面"
                value={pageIndex}
                onChange={setPageIndex}
                options={model.pages.map((page, index) => ({
                  value: index,
                  label: `第 ${page.number} 頁 · ${page.source === "ocr" ? "OCR" : page.classification?.source === "image" ? "圖片" : "文字層"}`,
                }))}
              />
            </div>
            {currentIssues.length > 0 && (
              <ul className="pdf2docx-issues">
                {currentIssues.map((issue, index) => (
                  <li key={index} data-severity={issue.severity}>
                    <strong>
                      {issue.severity === "error"
                        ? "無法完整讀取"
                        : issue.severity === "review"
                          ? "請核對"
                          : "提示"}
                    </strong>
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            <p className="pdf2docx-preview-caption">
              內容結構預覽 · 用來核對文字與閱讀順序，Word
              中的換行與分頁會依字型重新排版。
            </p>
            <StructurePreview page={currentPage} />
          </details>
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
        <p>掃描文件內容，完成後直接下載。無需調整設定。</p>
        <button
          type="button"
          className="button button--dark button--full"
          disabled={!pdf || loading || busy}
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
              ? "有頁面未能完整讀取，請重新掃描或查看掃描結果。"
              : reviewCount
                ? `已掃描全部 ${model.stats.pages} 頁；${reviewCount} 頁有核對提示，可展開掃描結果查看。`
                : `已掃描全部 ${model.stats.pages} 頁，可以下載 Word。`}
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

// Reuse the conversion tool's field and menu styles, including its portal menu.
function DocxSelectField<Value extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  describedBy,
}: {
  id: string;
  label: string;
  value: Value;
  options: { value: Value; label: string }[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <FormControl className="convert-format-field" fullWidth disabled={disabled}>
      <InputLabel id={`${id}-label`} shrink>
        {label}
      </InputLabel>
      <Select<Value>
        id={id}
        labelId={`${id}-label`}
        label={label}
        aria-describedby={describedBy}
        className="convert-format-select"
        variant="outlined"
        value={value}
        onChange={(event) => onChange(event.target.value as Value)}
        MenuProps={{
          disableScrollLock: true,
          slotProps: { paper: { className: "convert-format-menu" } },
        }}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}
