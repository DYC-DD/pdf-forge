import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState } from "react";

import { fileStem, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import {
  PDF_LIMITS,
  pdfFileError,
  pdfPageCountError,
  splitPlanError,
} from "../../shared/pdf/limits";
import { openPdf } from "../../shared/pdf/preview";
import { runSplitPdf } from "../../shared/pdf/runPdfOperation";
import { fireButtonConfetti } from "../../shared/ui/buttonConfetti";
import Counter, { ByteCounter } from "../../shared/ui/Counter";
import DropZone from "../../shared/ui/DropZone";
import PdfPageThumbnail from "../../shared/ui/PdfPageThumbnail";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import RubberSegment from "../../shared/ui/RubberSegment";
import useViewMode from "../../shared/ui/useViewMode";
import ViewModeToggle from "../../shared/ui/ViewModeToggle";
import { parsePageRange } from "./lib/parsePageRange";
import { resolveGroupFilenames } from "./lib/resolveGroupFilenames";
import type { PageGroup } from "./types";

export default function SplitWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [viewMode, setViewMode] = useViewMode();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<"custom" | "every">("custom");
  const [selected, setSelected] = useState<number[]>([]);
  const [rangeInput, setRangeInput] = useState("");
  const [groups, setGroups] = useState<PageGroup[]>([]);
  const [message, setMessage] = useState("");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [packingProgress, setPackingProgress] = useState<number | null>(null);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (!file) {
      setPdf(null);
      return;
    }
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const releaseTask = () => {
      const current = task;
      task = null;
      if (current) void current.destroy();
    };
    setLoading(true);
    setLoadError("");
    setPdf(null);
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

  function chooseFile(files: File[]) {
    if (processing || files.length === 0) return;
    const candidate = files[0];
    const error = pdfFileError(candidate);
    if (error) {
      setMessage(error);
      return;
    }
    setFile(candidate);
    setPreviewPage(null);
    setSelected([]);
    setGroups([]);
    setRangeInput("");
    setMessage("");
  }

  function clearFile() {
    if (processing) return;
    setFile(null);
    setPdf(null);
    setLoading(false);
    setLoadError("");
    setPreviewPage(null);
    setSelected([]);
    setGroups([]);
    setRangeInput("");
    setMessage("");
    setProgress(0);
    setPackingProgress(null);
  }

  function togglePage(page: number) {
    setSelected((current) =>
      current.includes(page)
        ? current.filter((entry) => entry !== page)
        : [...current, page].sort((a, b) => a - b)
    );
  }

  function applyRange() {
    if (!pdf) return;
    try {
      setSelected(parsePageRange(rangeInput, pdf.numPages));
      setMessage("");
    } catch (error) {
      setMessage(fileError(error));
    }
  }

  function addGroup() {
    if (selected.length === 0) return;
    setGroups((current) =>
      resolveGroupFilenames(file?.name ?? "document.pdf", [
        ...current,
        {
          id: crypto.randomUUID(),
          name: `部分 ${current.length + 1}`,
          pages: selected,
        },
      ])
    );
    setSelected([]);
    setRangeInput("");
    setMessage("");
  }

  async function handleExport() {
    if (!file || !pdf || processing) return;
    const exportGroups =
      mode === "every"
        ? Array.from({ length: pdf.numPages }, (_, index): PageGroup => ({
            id: `${index + 1}`,
            name: `page-${String(index + 1).padStart(
              String(pdf.numPages).length,
              "0"
            )}`,
            pages: [index + 1],
          }))
        : resolveGroupFilenames(file.name, groups);
    if (exportGroups.length === 0) return;
    const planError =
      pdfFileError(file) ??
      pdfPageCountError(pdf.numPages) ??
      splitPlanError(exportGroups);
    if (planError) {
      setMessage(planError);
      return;
    }
    if (mode === "custom") setGroups(exportGroups);
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setProgress(0);
    setPackingProgress(null);
    setMessage("");
    try {
      const result = await runSplitPdf(file, exportGroups, {
        signal: controller.signal,
        onProgress: setProgress,
        onPackingProgress: setPackingProgress,
      });
      saveBlob(result.blob, result.filename);
      setMessage(
        `完成！已下載 ${result.fileCount} 份 PDF${
          result.fileCount > 1 ? "（ZIP）" : ""
        }。`
      );
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "AbortError"
          ? "已取消拆分。"
          : fileError(error)
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProcessing(false);
    }
  }

  const pages = pdf
    ? Array.from({ length: pdf.numPages }, (_, index) => index + 1)
    : [];
  const outputCount = mode === "every" ? (pdf?.numPages ?? 0) : groups.length;
  const planError =
    mode === "every" && pdf
      ? pdf.numPages > PDF_LIMITS.splitFiles
        ? `每頁一檔最多可輸出 ${PDF_LIMITS.splitFiles} 份 PDF；請改用自訂範圍。`
        : null
      : splitPlanError(groups);
  const selectedPages = useMemo(() => new Set(selected), [selected]);
  const groupCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const group of groups) {
      for (const page of group.pages) {
        counts.set(page, (counts.get(page) ?? 0) + 1);
      }
    }
    return counts;
  }, [groups]);

  return (
    <div className="workspace-grid">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="split-heading"
      >
        <div className="card-header file-card-header">
          <div>
            <div className="eyebrow">01 / 選擇頁面</div>
            <h2 id="split-heading">把需要的頁面留下來</h2>
            <p>點選頁面組成新檔案，點眼睛圖示可放大預覽。</p>
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
                  disabled={processing}
                  aria-label="清除 PDF"
                >
                  <PublicIcon name="trash" size={15} />
                  清除
                </button>
                <ViewModeToggle
                  value={viewMode}
                  onChange={setViewMode}
                  disabled={processing}
                />
              </div>
            </div>
          )}
        </div>
        {!file ? (
          <DropZone multiple={false} onFiles={chooseFile} />
        ) : (
          <>
            <div className="source-file">
              <div className="source-file-icon">
                <PublicIcon name="files" size={22} />
              </div>
              <div>
                <strong>{file.name}</strong>
                <span>
                  <ByteCounter size={file.size} />
                  {pdf && (
                    <>
                      {" · "}
                      <Counter value={pdf.numPages} /> 頁
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
                <div
                  className={`split-toolbar${mode === "custom" ? " split-toolbar--custom" : ""}`}
                >
                  <RubberSegment
                    className="split-mode-segment"
                    aria-label="拆分方式"
                    items={[
                      {
                        value: "custom",
                        label: "自選頁面",
                        icon: <PublicIcon name="scissors" size={17} />,
                      },
                      {
                        value: "every",
                        label: "每頁一檔",
                        icon: <PublicIcon name="files" size={17} />,
                      },
                    ]}
                    value={mode}
                    onChange={(_, index) => {
                      setMode(index === 0 ? "custom" : "every");
                      setMessage("");
                    }}
                    trackColor="#111215"
                    thumbColor="#383a40"
                    textColor="#f0f0f1"
                    activeTextColor="#f0f0f1"
                    size="md"
                    radius={10}
                    inset={3}
                    equalSlots
                    draggable
                  />
                  {mode === "custom" && (
                    <div className="range-form">
                      <div>
                        <TextField
                          id="page-range"
                          className="page-range-field"
                          label="快速選取頁碼"
                          variant="outlined"
                          size="small"
                          slotProps={{ inputLabel: { shrink: true } }}
                          value={rangeInput}
                          onChange={(event) =>
                            setRangeInput(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") applyRange();
                          }}
                          placeholder="例如 1-3, 5, 8"
                        />
                        <button
                          className="button button--small button--dark"
                          onClick={applyRange}
                        >
                          套用
                        </button>
                      </div>
                    </div>
                  )}
                  {mode === "custom" && (
                    <div className="selection-actions">
                      <span>
                        已選 <Counter value={selected.length} /> 頁
                      </span>
                      <button onClick={() => setSelected(pages)}>全選</button>
                      <button onClick={() => setSelected([])}>清除</button>
                    </div>
                  )}
                </div>
                <div className={`pdf-collection pdf-collection--${viewMode}`}>
                  {pages.map((pageNumber) => (
                    <PdfPageThumbnail
                      key={`${file.name}-${pageNumber}`}
                      pdf={pdf}
                      pageNumber={pageNumber}
                      viewMode={viewMode}
                      selected={
                        mode === "every" || selectedPages.has(pageNumber)
                      }
                      disabled={mode === "every"}
                      readOnly={mode === "every"}
                      readOnlyLabel="每頁一檔"
                      groupCount={
                        mode === "custom"
                          ? (groupCounts.get(pageNumber) ?? 0)
                          : 0
                      }
                      onToggle={() => {
                        if (mode === "custom") togglePage(pageNumber);
                      }}
                      onPreview={() => setPreviewPage(pageNumber)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />{" "}
          檔案只在你的瀏覽器中處理，不會上傳。
        </div>
      </section>

      <aside
        className="workspace-card output-card"
        aria-labelledby="split-output-heading"
      >
        <div className="eyebrow">02 / 建立檔案</div>
        <h2 id="split-output-heading">輸出清單</h2>
        <p>
          {mode === "custom"
            ? "選好頁面後加入一組；每組會成為一份 PDF。"
            : "原檔每一頁會各自成為一份 PDF。"}
        </p>
        {mode === "custom" ? (
          <>
            <button
              className="button button--dark button--full add-group"
              onClick={addGroup}
              disabled={selected.length === 0 || processing}
            >
              <PublicIcon name="plus" size={18} /> 將{" "}
              <Counter value={selected.length} /> 頁加入新檔案
            </button>
            {groups.length > 0 && (
              <div className="group-name-hint" id="split-name-hint">
                檔名可自訂，留空時使用預設名稱；同名時自動補上編號。
              </div>
            )}
            <div className="group-list">
              {groups.length === 0 ? (
                <div className="empty-groups">
                  <PublicIcon name="files" size={25} />
                  <strong>尚無輸出檔案</strong>
                  <span>從左側選頁，再加入新檔案。</span>
                </div>
              ) : (
                groups.map((group, index) => (
                  <div className="group-card" key={group.id}>
                    <div className="group-card-heading">
                      <span className="group-number">
                        <Counter value={index + 1} minimumIntegerDigits={2} />
                      </span>
                      <strong className="group-label">{group.name}</strong>
                      <span className="group-page-summary">
                        <Counter value={group.pages.length} /> 頁 ·{" "}
                        {group.pages.join(", ")}
                      </span>
                      <button
                        className="icon-button icon-button--danger"
                        onClick={() =>
                          setGroups((current) =>
                            current.filter((entry) => entry.id !== group.id)
                          )
                        }
                        disabled={processing}
                        aria-label={`移除 ${group.filename?.trim() || group.name}`}
                      >
                        <PublicIcon name="trash" size={16} />
                      </button>
                    </div>
                    <TextField
                      id={`split-group-filename-${group.id}`}
                      className="filename-field split-group-filename"
                      label="輸出檔名"
                      variant="outlined"
                      fullWidth
                      value={
                        group.filename ??
                        `${fileStem(file?.name ?? "document.pdf")}-${group.name}`
                      }
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const filename = event.target.value.replace(
                          /\.pdf$/i,
                          ""
                        );
                        setGroups((current) =>
                          current.map((entry) =>
                            entry.id === group.id
                              ? { ...entry, filename }
                              : entry
                          )
                        );
                      }}
                      onBlur={() => {
                        setGroups((current) =>
                          resolveGroupFilenames(
                            file?.name ?? "document.pdf",
                            current,
                            group.id
                          )
                        );
                      }}
                      disabled={processing}
                      slotProps={{
                        input: {
                          endAdornment: (
                            <InputAdornment position="end" disableTypography>
                              .pdf
                            </InputAdornment>
                          ),
                        },
                        htmlInput: {
                          "aria-label": `第 ${index + 1} 份輸出檔名`,
                          "aria-describedby": "split-name-hint",
                          autoComplete: "off",
                          spellCheck: false,
                        },
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="every-summary">
            <PublicIcon name="checks" size={24} />
            <div>
              <strong>
                {pdf ? (
                  <>
                    <Counter value={pdf.numPages} /> 份獨立 PDF
                  </>
                ) : (
                  "等待匯入 PDF"
                )}
              </strong>
              <span>多個檔案會打包為 ZIP 下載。</span>
            </div>
          </div>
        )}
        <div className="output-divider" />
        <div className="output-count">
          <span>準備輸出</span>
          <strong>
            <Counter value={outputCount} /> 份 PDF
          </strong>
        </div>
        {planError && (
          <p className="status-message" role="status">
            {planError}
          </p>
        )}
        <button
          className="button button--accent button--full"
          disabled={!pdf || outputCount === 0 || processing || !!planError}
          onClick={(event) => {
            void handleExport();
            fireButtonConfetti(event.currentTarget);
          }}
        >
          <PublicIcon name="download" size={18} />
          {processing
            ? packingProgress === null
              ? `處理中 ${progress}/${outputCount}`
              : `建立 ZIP 中 ${packingProgress}%`
            : outputCount > 1
              ? "下載 ZIP 檔"
              : "下載 PDF"}
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
          若原檔只有編輯權限限制，輸出檔不會保留原加密設定。
        </p>
        {message && (
          <p
            className={`status-message ${
              message.includes("完成") ? "status-message--success" : ""
            }`}
            role="status"
          >
            {message}
          </p>
        )}
      </aside>
      {file && pdf && previewPage !== null && (
        <PdfPreviewDialog
          key={`${file.name}-${previewPage}`}
          file={file}
          pdf={pdf}
          initialPage={previewPage}
          onClose={() => setPreviewPage(null)}
        />
      )}
    </div>
  );
}
