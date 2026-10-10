import Checkbox from "@mui/material/Checkbox";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";

import { fileStem, formatBytes, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { pdfPageCountError } from "../../shared/pdf/limits";
import { openPdf } from "../../shared/pdf/preview";
import DropZone from "../../shared/ui/DropZone";
import OutputFilenameField from "../../shared/ui/OutputFilenameField";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import { parsePageRange } from "../split/lib/parsePageRange";
import { analyzePdf } from "./lib/analyzePdf";
import { DOCX_LIMITS, docxInputError } from "./lib/limits";
import { detectPageSetups, pageSetupLabel } from "./lib/pageSetup";
import { runDocxExport } from "./lib/runDocxJob";
import StructurePreview from "./StructurePreview";
import type {
  ConversionProgress,
  DocumentModel,
  OcrLanguage,
  OcrMode,
} from "./types";

export default function Pdf2DocxWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState("");
  const [ocr, setOcr] = useState<OcrMode>("auto");
  const [language, setLanguage] = useState<OcrLanguage>("chi_tra+eng");
  const [preservePageBreaks, setPreservePageBreaks] = useState(false);
  const [name, setName] = useState("document");
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
        if (!cancelled) {
          setPdf(source);
          // Large documents start with one page so the selection is always valid.
          setRange(
            source.numPages > DOCX_LIMITS.pages
              ? "1"
              : source.numPages === 1
                ? "1"
                : `1-${source.numPages}`
          );
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
    setRange("");
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
    setName(fileStem(files[0].name));
    setRange("");
    invalidate();
  }

  let pages: number[] = [],
    selectionError = "";
  if (pdf) {
    try {
      pages = parsePageRange(range, pdf.numPages);
      if (pages.length > DOCX_LIMITS.pages)
        selectionError = "每次最多分析 50 頁，請縮小頁碼範圍。";
      if (ocr === "always" && pages.length > DOCX_LIMITS.ocrPages)
        selectionError = "整頁重新辨識每次最多 10 頁，請縮小頁碼範圍。";
    } catch (error) {
      selectionError = fileError(error);
    }
  }

  async function analyze() {
    if (
      !file ||
      !pdf ||
      selectionError ||
      !pages.length ||
      controllerRef.current
    )
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    invalidate();
    setProgress({ stage: "read", page: pages[0], total: pages.length });
    try {
      const result = await analyzePdf(file, pages, {
        ocr,
        language,
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
    if (!model || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setMessage("");
    setSuccess(false);
    setProgress({ stage: "export", page: 0, total: model.pages.length });
    try {
      const blob = await runDocxExport(
        model,
        { preservePageBreaks },
        controller.signal
      );
      if (mountedRef.current && !controller.signal.aborted) {
        saveBlob(blob, `${fileStem(name.replace(/\.docx$/iu, ""))}.docx`);
        setMessage("已產生可編輯的 Word 檔案，請開啟後核對內容與排版。");
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
  const pageSetups = useMemo(
    () => (model ? detectPageSetups(model.pages) : []),
    [model]
  );
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
            <div className="eyebrow">01 / 加入與分析 · 開發預覽</div>
            <h2 id="pdf2docx-heading">把 PDF 重建為可編輯文件</h2>
            <p>先分析內容，再檢查段落、閱讀順序與表格。</p>
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
                  onClick={() =>
                    setPreviewPage(currentPage?.number ?? pages[0] ?? 1)
                  }
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
            {pdf && (
              <div className="pdf2docx-range">
                <TextField
                  id="pdf2docx-range"
                  className="filename-field"
                  label="分析頁碼"
                  variant="outlined"
                  fullWidth
                  error={!!selectionError}
                  slotProps={{
                    inputLabel: { shrink: true },
                    htmlInput: { "aria-describedby": "pdf2docx-range-hint" },
                  }}
                  value={range}
                  onChange={(event) => {
                    setRange(event.target.value);
                    invalidate();
                  }}
                  placeholder="例如 1-3, 5"
                  disabled={busy}
                />
                <p id="pdf2docx-range-hint">
                  {selectionError ||
                    `已選 ${pages.length} 頁。每次最多 50 頁；本機 OCR 最多 10 頁。`}
                </p>
              </div>
            )}
            {!model && !busy && (
              <div className="pdf2docx-empty">
                <PublicIcon name="list" size={26} />
                <strong>分析後在這裡檢查內容</strong>
                <p>
                  正文會合併為可編輯段落；辨識到的清單與有框線表格會保留為 Word
                  結構。
                </p>
              </div>
            )}
          </>
        )}
        {busy && (
          <div className="pdf2docx-progress" role="status">
            <progress aria-label="文件處理中" />
            <strong>{progressText}</strong>
            <span>全部在本機處理，選取 {progress?.total} 頁。</span>
          </div>
        )}
        {model && currentPage && (
          <div className="pdf2docx-analysis">
            <dl className="pdf2docx-stats">
              <div>
                <dt>已讀取字元</dt>
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
          </div>
        )}
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />
          PDF、文字與圖片只在瀏覽器中處理，不會上傳。
        </div>
      </section>
      <aside
        className="workspace-card output-card convert-output-card pdf2docx-settings"
        aria-labelledby="pdf2docx-output-heading"
      >
        <div className="eyebrow">02 / Word 輸出</div>
        <h2 id="pdf2docx-output-heading">建立 Word 文件</h2>
        <p>開發預覽優先保留可編輯結構；複雜文件仍需逐頁核對。</p>
        <div className="pdf2docx-field">
          <DocxSelectField<OcrMode>
            id="pdf2docx-ocr"
            label="文字辨識"
            value={ocr}
            disabled={busy}
            describedBy="pdf2docx-ocr-hint"
            onChange={(value) => {
              setOcr(value);
              invalidate();
            }}
            options={[
              { value: "auto", label: "自動：優先讀取文字層" },
              { value: "off", label: "只讀文字層，不使用 OCR" },
              { value: "always", label: "整頁重新辨識（本機 OCR）" },
            ]}
          />
          <p id="pdf2docx-ocr-hint" className="convert-format-hint">
            自動模式會辨識只有圖片或文字編碼異常的頁面。圖片中的局部文字請使用整頁重新辨識。
          </p>
        </div>
        <div className="pdf2docx-field">
          <DocxSelectField<OcrLanguage>
            id="pdf2docx-language"
            label="OCR 語言"
            value={language}
            disabled={busy || ocr === "off"}
            describedBy="pdf2docx-language-hint"
            onChange={(value) => {
              setLanguage(value);
              invalidate();
            }}
            options={[
              { value: "chi_tra+eng", label: "繁體中文＋英文" },
              { value: "eng", label: "英文" },
            ]}
          />
          <p id="pdf2docx-language-hint" className="convert-format-hint">
            首次使用會從本站下載辨識模型；文件內容留在本機。
          </p>
        </div>
        <button
          type="button"
          className="button button--dark button--full"
          disabled={!pdf || loading || busy || !!selectionError}
          onClick={() => void analyze()}
        >
          <PublicIcon name="zoom-scan" size={18} />
          {model ? "重新分析文件" : "分析文件內容"}
        </button>
        <div className="output-divider" />
        <div className="pdf2docx-auto-layout">
          <strong>自動辨識紙張與邊界</strong>
          <p>依原稿尺寸與正文位置判斷，優先匹配常見紙張及窄／標準邊界。</p>
          {currentPage && pageSetups[pageIndex] && (
            <p className="pdf2docx-detected-layout" role="status">
              原稿第 {currentPage.number} 頁：
              {pageSetupLabel(pageSetups[pageIndex])}
            </p>
          )}
        </div>
        <FormControlLabel
          className="pdf2docx-checkbox"
          disabled={busy}
          control={
            <Checkbox
              size="small"
              checked={preservePageBreaks}
              slotProps={{
                input: { "aria-describedby": "pdf2docx-breaks-hint" },
              }}
              onChange={(event) => {
                setPreservePageBreaks(event.target.checked);
                setMessage("");
              }}
            />
          }
          label="在原稿頁面之間加入分頁"
        />
        <p id="pdf2docx-breaks-hint" className="pdf2docx-option-hint">
          預設讓內容自然流動，方便編輯。加入分頁也可能因字型差異增加 Word 頁數。
        </p>
        <OutputFilenameField
          id="pdf2docx-name"
          value={name}
          onChange={setName}
          defaultName={file ? fileStem(file.name) : "document"}
          placeholder="document"
          extension="docx"
          disabled={!file || busy}
        />
        {model && (
          <p className="pdf2docx-result-note">
            {blocked
              ? "有頁面未能完整讀取，請調整頁碼或辨識模式後重新分析。"
              : reviewCount
                ? `${reviewCount} 頁需要核對，可在左側切換頁面查看。`
                : "內容結構已建立，可下載後在 Word 中編輯。"}
          </p>
        )}
        <button
          type="button"
          className="button button--accent button--full"
          onClick={() => void download()}
          disabled={!model || blocked || busy}
        >
          <PublicIcon name="download" size={18} />
          下載可編輯 Word
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
          目前支援橫排段落、清單、雙欄、有框線表格、基本分數及圖片。直排、複雜公式、無框線表格與複雜圖形仍在開發。
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
