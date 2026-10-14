import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";

import { fileStem, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { pdfPageCountError } from "../../shared/pdf/limits";
import { openPdf } from "../../shared/pdf/preview";
import { fireButtonConfetti } from "../../shared/ui/buttonConfetti";
import Counter, { ByteCounter } from "../../shared/ui/Counter";
import DropZone from "../../shared/ui/DropZone";
import OutputFilenameField from "../../shared/ui/OutputFilenameField";
import PdfPageThumbnail from "../../shared/ui/PdfPageThumbnail";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import useViewMode from "../../shared/ui/useViewMode";
import ViewModeToggle from "../../shared/ui/ViewModeToggle";
import WordOutput from "../pdf2docx/WordOutput";
import { parsePageRange } from "../split/lib/parsePageRange";
import {
  convertPdfToImages,
  imagePageCountError,
  type ImageFormat,
} from "./lib/convertPdfToImages";

type PdfOutputFormat = ImageFormat | "word";

function WordFormatLabel() {
  return (
    <span className="convert-word-label">
      Word <span className="convert-beta-badge">beta</span>
      <span>：可編輯文件</span>
    </span>
  );
}

export default function PdfConversionWorkspace({
  file,
  onFiles,
  onClear,
  detecting,
  intakeError,
}: {
  file: File | null;
  onFiles: (files: File[]) => void;
  onClear: () => void;
  detecting: boolean;
  intakeError: string;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [viewMode, setViewMode] = useViewMode();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [rangeInput, setRangeInput] = useState("");
  const [format, setFormat] = useState<PdfOutputFormat>("jpg");
  const [outputName, setOutputName] = useState("images");
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [processing, setProcessing] = useState(false);
  const [wordBusy, setWordBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [packingProgress, setPackingProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const busy = processing || wordBusy;

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!file) return;
    setOutputName(`${fileStem(file.name)}-images`);
    setLoading(true);
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const releaseTask = () => {
      const current = task;
      task = null;
      if (current) void current.destroy();
    };
    openPdf(file)
      .then(async (openedTask) => {
        if (cancelled) {
          await openedTask.destroy();
          return;
        }
        task = openedTask;
        const document = await openedTask.promise;
        if (cancelled) return;
        const error = pdfPageCountError(document.numPages);
        if (error) throw new Error(error);
        setPdf(document);
        setSelected(Array.from({ length: document.numPages }, (_, i) => i + 1));
      })
      .catch((error) => {
        releaseTask();
        if (!cancelled) setLoadError(fileError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      releaseTask();
    };
  }, [file]);

  function clearFile() {
    if (busy) return;
    onClear();
    setPdf(null);
    setLoading(false);
    setLoadError("");
    setSelected([]);
    setRangeInput("");
    setPreviewPage(null);
    setOutputName("images");
    setFormat("jpg");
    setMessage("");
    setSuccess(false);
    setProgress(0);
    setPackingProgress(null);
  }

  function togglePage(page: number) {
    if (busy) return;
    setSelected((current) =>
      current.includes(page)
        ? current.filter((entry) => entry !== page)
        : [...current, page].sort((a, b) => a - b)
    );
    setMessage("");
  }

  function applyRange() {
    if (!pdf || busy) return;
    try {
      setSelected(parsePageRange(rangeInput, pdf.numPages));
      setMessage("");
    } catch (error) {
      setMessage(fileError(error));
      setSuccess(false);
    }
  }

  async function handleExport() {
    if (
      !file ||
      !pdf ||
      busy ||
      format === "word" ||
      controllerRef.current ||
      planError
    )
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setProgress(0);
    setPackingProgress(null);
    setMessage("");
    setSuccess(false);
    try {
      const result = await convertPdfToImages(file, {
        pages: selected,
        format,
        outputName,
        signal: controller.signal,
        onProgress: setProgress,
        onPackingProgress: setPackingProgress,
      });
      if (controller.signal.aborted) return;
      saveBlob(result.blob, result.filename);
      setSuccess(true);
      setMessage(
        `完成！已下載 ${result.fileCount} 張 ${format.toUpperCase()} 圖片${result.fileCount > 1 ? "（ZIP）" : ""}。`
      );
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "AbortError"
          ? "已取消轉換。"
          : fileError(error)
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProcessing(false);
    }
  }

  const pages = useMemo(
    () => Array.from({ length: pdf?.numPages ?? 0 }, (_, i) => i + 1),
    [pdf]
  );
  const selectedPages = useMemo(() => new Set(selected), [selected]);
  const outputCount = selected.length;
  const planError =
    pdf && format !== "word" ? imagePageCountError(outputCount) : null;
  const extension =
    format === "word" ? "docx" : outputCount > 1 ? "zip" : format;
  const defaultName = file
    ? `${fileStem(file.name)}${format === "word" ? "" : "-images"}`
    : "images";

  return (
    <div className="workspace-grid">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="convert-heading"
      >
        <div className="card-header file-card-header">
          <div>
            <div className="eyebrow">01 / {file ? "選擇頁面" : "加入檔案"}</div>
            <h2 id="convert-heading">
              {file ? "選擇要轉換的 PDF 頁面" : "轉換 PDF 與圖片"}
            </h2>
            <p>
              {file
                ? "選取要轉換的頁面，點眼睛圖示可放大預覽。"
                : "加入 PDF 或 JPG／PNG，自動辨識來源格式。"}
            </p>
          </div>
          {file && (
            <div className="file-list-actions">
              <span className="count-badge">
                <Counter value={1} /> 份檔案
              </span>
              <div className="file-list-action-buttons">
                <button
                  type="button"
                  className="clear-files-button"
                  onClick={clearFile}
                  disabled={busy}
                  aria-label="清除 PDF"
                >
                  <PublicIcon name="trash" size={15} /> 清除
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
            multiple
            onFiles={onFiles}
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            label="選擇 PDF 或圖片"
            title={detecting ? "正在辨識檔案…" : "拖曳 PDF 或圖片到這裡"}
            description="點擊選擇一份 PDF，或多張 JPG／PNG 圖片"
            disabled={detecting}
          />
        ) : (
          <>
            <div className="source-file">
              <div className="source-file-icon">
                <PublicIcon name="file-type-pdf" size={22} />
              </div>
              <div>
                <strong title={file.name}>{file.name}</strong>
                <span>
                  <ByteCounter size={file.size} />
                  {pdf && (
                    <>
                      {" "}
                      · <Counter value={pdf.numPages} /> 頁
                    </>
                  )}
                </span>
              </div>
            </div>
            {loading && <div className="loading-panel">正在讀取頁面…</div>}
            {loadError && (
              <p className="status-message" role="alert">
                {loadError}
              </p>
            )}
            {pdf && (
              <>
                <div className="split-toolbar split-toolbar--custom">
                  <div className="range-form">
                    <div>
                      <TextField
                        id="convert-page-range"
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
                      已選 <Counter value={outputCount} /> 頁
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSelected(pages);
                        setMessage("");
                      }}
                    >
                      全選
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setSelected([]);
                        setMessage("");
                      }}
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
        {intakeError && (
          <p className="status-message" role="alert">
            {intakeError}
          </p>
        )}
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />
          檔案只在你的瀏覽器中處理，不會上傳。
        </div>
      </section>

      <aside
        className={`workspace-card output-card convert-output-card${format === "word" ? " pdf2docx-output" : ""}`}
        aria-labelledby="convert-output-heading"
      >
        <div className="eyebrow">02 / 轉換與匯出</div>
        <h2 id="convert-output-heading">設定輸出格式</h2>
        <p>
          {file
            ? format === "word"
              ? "所選頁面依原稿順序合併成一份 Word。"
              : "每頁輸出一張圖片，多張圖片會打包為 ZIP。"
            : "加入檔案後，自動顯示可用的輸出格式。"}
        </p>
        <div className="convert-format">
          <FormControl className="convert-format-field" fullWidth>
            <InputLabel id="convert-format-label" shrink>
              輸出格式
            </InputLabel>
            <Select<PdfOutputFormat | "">
              id="convert-format"
              labelId="convert-format-label"
              label="輸出格式"
              aria-describedby="convert-format-hint"
              className="convert-format-select"
              variant="outlined"
              value={file ? format : ""}
              displayEmpty
              renderValue={(value) =>
                value === "" ? (
                  detecting ? (
                    "正在辨識檔案…"
                  ) : (
                    "加入檔案後自動顯示"
                  )
                ) : value === "jpg" ? (
                  "JPG：適用於照片與日常分享"
                ) : value === "png" ? (
                  "PNG：適用於文字、圖表與線條"
                ) : (
                  <WordFormatLabel />
                )
              }
              onChange={(event) => {
                const nextFormat = event.target.value as PdfOutputFormat;
                if (file && outputName === defaultName) {
                  setOutputName(
                    `${fileStem(file.name)}${nextFormat === "word" ? "" : "-images"}`
                  );
                }
                setFormat(nextFormat);
                setMessage("");
                setSuccess(false);
              }}
              disabled={busy || !file}
              MenuProps={{
                disableScrollLock: true,
                slotProps: { paper: { className: "convert-format-menu" } },
              }}
            >
              <MenuItem value="jpg">JPG：適用於照片與日常分享</MenuItem>
              <MenuItem value="png">PNG：適用於文字、圖表與線條</MenuItem>
              <MenuItem value="word">
                <WordFormatLabel />
              </MenuItem>
            </Select>
          </FormControl>
          <p id="convert-format-hint" className="convert-format-hint">
            {!file ? (
              <>
                PDF 可轉 JPG、PNG 或 Word（beta）
                <br />
                圖片可轉 PDF、JPG、PNG、SVG 或 WEBP
              </>
            ) : format === "word" ? (
              "Word beta：此功能仍在開發與優化中，轉換後請核對內容與排版。"
            ) : format === "jpg" ? (
              "最高畫質 JPG，適合照片與日常分享。"
            ) : (
              "無損 PNG，適合文字、圖表與線條。"
            )}
          </p>
        </div>
        <div className="output-divider" />
        <div className="output-count">
          <span>準備輸出</span>
          <strong>
            {file ? (
              format === "word" ? (
                <>
                  1 份 Word · <Counter value={outputCount} /> 頁
                </>
              ) : (
                <>
                  <Counter value={outputCount} /> 張 {format.toUpperCase()}
                </>
              )
            ) : (
              "等待加入檔案"
            )}
          </strong>
        </div>
        {file ? (
          <OutputFilenameField
            id="convert-name"
            value={outputName}
            onChange={(value) =>
              setOutputName(
                value.replace(/\.(?:pdf|jpg|jpeg|png|zip|docx)$/i, "")
              )
            }
            defaultName={defaultName}
            placeholder={format === "word" ? "document" : "images"}
            extension={extension}
            disabled={busy}
          />
        ) : (
          <TextField
            id="convert-name"
            className="filename-field"
            label="輸出檔名"
            placeholder="加入檔案後自動產生"
            value=""
            fullWidth
            disabled
            slotProps={{ inputLabel: { shrink: true } }}
          />
        )}
        {file && format === "word" ? (
          <WordOutput
            file={file}
            pages={selected}
            pageCount={pdf?.numPages ?? 0}
            loading={loading}
            outputName={outputName}
            onBusyChange={setWordBusy}
          />
        ) : (
          <>
            {planError && (
              <p className="status-message" role="status">
                {planError}
              </p>
            )}
            <button
              type="button"
              className="button button--accent button--full"
              disabled={!pdf || loading || busy || !!planError}
              onClick={(event) => {
                void handleExport();
                fireButtonConfetti(event.currentTarget);
              }}
            >
              <PublicIcon name="download" size={18} />
              {!file
                ? "轉換並下載"
                : processing
                  ? packingProgress === null
                    ? `轉換中 ${progress}/${outputCount}`
                    : `建立 ZIP 中 ${packingProgress}%`
                  : outputCount > 1
                    ? "下載 ZIP 檔"
                    : `下載 ${format.toUpperCase()} 圖片`}
            </button>
            {processing && (
              <button
                type="button"
                className="button button--outline button--full operation-cancel"
                onClick={() => controllerRef.current?.abort()}
              >
                取消處理
              </button>
            )}
            <p className="encryption-note">
              {file
                ? "圖片會保留頁面外觀與白色背景，文字轉為圖片後無法選取。"
                : "單張圖片直接下載，多張圖片打包為 ZIP，圖片轉 PDF 合併為一份。"}
            </p>
          </>
        )}
        {message && (
          <p
            className={`status-message ${success ? "status-message--success" : ""}`}
            role="status"
          >
            {message}
          </p>
        )}
      </aside>
      {file && pdf && previewPage !== null && (
        <PdfPreviewDialog
          file={file}
          pdf={pdf}
          initialPage={previewPage}
          onClose={() => setPreviewPage(null)}
        />
      )}
    </div>
  );
}
