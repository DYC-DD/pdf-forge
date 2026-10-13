import CircularProgress from "@mui/material/CircularProgress";
import { useEffect, useRef, useState } from "react";

import { fileStem, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import PublicIcon from "../../shared/ui/PublicIcon";
import { docxInputError } from "./lib/limits";
import type { ConversionProgress, DocumentModel } from "./types";

export default function WordOutput({
  file,
  pages,
  pageCount,
  loading,
  outputName,
  onBusyChange,
}: {
  file: File;
  pages: number[];
  pageCount: number;
  loading: boolean;
  outputName: string;
  onBusyChange: (busy: boolean) => void;
}) {
  const [model, setModel] = useState<DocumentModel | null>(null);
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
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    setModel(null);
    setMessage("");
    setSuccess(false);
  }, [file, pages]);

  const inputError = docxInputError(file);
  const busy = !!progress;
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

  function finish(controller: AbortController) {
    if (controllerRef.current !== controller) return;
    controllerRef.current = null;
    if (mountedRef.current) {
      setProgress(null);
      onBusyChange(false);
    }
  }

  async function analyze() {
    if (
      !pageCount ||
      !pages.length ||
      loading ||
      inputError ||
      controllerRef.current
    )
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    onBusyChange(true);
    setModel(null);
    setMessage("");
    setSuccess(false);
    setProgress({ stage: "read", page: pages[0], total: pages.length });
    try {
      const { analyzePdf } = await import("./lib/analyzePdf");
      const result = await analyzePdf(file, pages, {
        signal: controller.signal,
        onProgress: (value) => {
          if (mountedRef.current && !controller.signal.aborted)
            setProgress(value);
        },
      });
      if (mountedRef.current && !controller.signal.aborted) setModel(result);
    } catch (error) {
      if (mountedRef.current)
        setMessage(
          controller.signal.aborted ? "已取消分析。" : fileError(error)
        );
    } finally {
      finish(controller);
    }
  }

  async function download() {
    if (!model || blocked || controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    onBusyChange(true);
    setMessage("");
    setSuccess(false);
    setProgress({ stage: "export", page: 0, total: model.pages.length });
    try {
      const { runDocxExport } = await import("./lib/runDocxJob");
      const blob = await runDocxExport(
        model,
        { preservePageBreaks: true },
        controller.signal
      );
      if (mountedRef.current && !controller.signal.aborted) {
        saveBlob(blob, `${fileStem(outputName || file.name)}.docx`);
        setMessage("已產生 Word 檔案，請開啟後核對內容與排版。");
        setSuccess(true);
      }
    } catch (error) {
      if (mountedRef.current)
        setMessage(
          controller.signal.aborted ? "已取消產生 Word。" : fileError(error)
        );
    } finally {
      finish(controller);
    }
  }

  return (
    <>
      {pageCount > 0 && (
        <p className="pdf2docx-result-note" role="status">
          {pages.length
            ? `已選 ${pages.length} / ${pageCount} 頁，掃描完成後即可下載。`
            : "請先從左側選取至少一頁。"}
        </p>
      )}
      {inputError && (
        <p className="status-message" role="alert">
          {inputError}
        </p>
      )}
      <button
        type="button"
        className="button button--dark button--full"
        disabled={
          !pageCount || !pages.length || loading || busy || !!inputError
        }
        onClick={() => void analyze()}
      >
        <PublicIcon name="zoom-scan" size={18} />
        {model ? "重新掃描文件內容" : "掃描文件內容"}
      </button>
      {busy && (
        <div className="pdf2docx-progress" role="status" aria-busy="true">
          <CircularProgress
            className="workspace-loading-spinner"
            color="inherit"
            size={40}
            aria-label="文件處理中"
          />
          <strong>{progressText}</strong>
          <span>全部在本機處理，共 {progress?.total} 頁。</span>
        </div>
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
    </>
  );
}
