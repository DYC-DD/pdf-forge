import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import { useEffect, useRef, useState } from "react";

import { fileStem, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import {
  COMPRESSION_LIMITS,
  pdfFileError,
  pdfPageCountError,
} from "../../shared/pdf/limits";
import { inspectPdf } from "../../shared/pdf/preview";
import { fireButtonConfetti } from "../../shared/ui/buttonConfetti";
import Counter, { ByteCounter } from "../../shared/ui/Counter";
import DropZone from "../../shared/ui/DropZone";
import OutputFilenameField from "../../shared/ui/OutputFilenameField";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import { compressPdf } from "./lib/compressPdf";
import type { CompressionMode } from "./types";

type CompressionResult = {
  file: File;
  smaller: boolean;
};

const compressionModes: Record<
  CompressionMode,
  { label: string; description: string }
> = {
  high: {
    label: "高壓縮",
    description: "縮小可處理的大型圖片，照片細節可能降低。",
  },
  medium: {
    label: "中壓縮",
    description: "重新編碼可處理的圖片，保留原解析度；照片細節可能降低。",
  },
  low: {
    label: "低壓縮",
    description: "只壓縮 PDF 結構，不重新編碼圖片。",
  },
};

export default function CompressWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<CompressionMode>("medium");
  const [outputName, setOutputName] = useState("compressed.pdf");
  const [result, setResult] = useState<CompressionResult | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setLoading(true);
    inspectPdf(file, pdfPageCountError, COMPRESSION_LIMITS.imagePixels)
      .then((info) => {
        if (cancelled) return;
        setPageCount(info.pageCount);
        setThumbnail(info.thumbnail);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(fileError(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  function chooseFile(files: File[]) {
    if (processing || files.length === 0) return;
    const chosen = files[0];
    const error = pdfFileError(chosen);
    if (error) {
      setMessage(error);
      return;
    }
    setFile(chosen);
    setPageCount(null);
    setThumbnail("");
    setLoadError("");
    setResult(null);
    setPreviewFile(null);
    setOutputName(`${fileStem(chosen.name)}-compressed.pdf`);
    setMessage("");
  }

  function clearFile() {
    if (processing) return;
    setFile(null);
    setPageCount(null);
    setThumbnail("");
    setLoading(false);
    setLoadError("");
    setResult(null);
    setPreviewFile(null);
    setOutputName("compressed.pdf");
    setMessage("");
  }

  function chooseMode(nextMode: CompressionMode) {
    if (processing || nextMode === mode) return;
    setMode(nextMode);
    setResult(null);
    setMessage("");
  }

  async function handleCompress() {
    if (!file || pageCount === null || loading || loadError || processing)
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setResult(null);
    setMessage("");
    try {
      const { blob, appliedMode } = await compressPdf(
        file,
        mode,
        controller.signal
      );
      if (blob.size >= file.size) {
        setResult({ file, smaller: false });
        setMessage(
          "目前模式無法再縮小這份 PDF；內容可能已壓縮，或圖片格式不適用。"
        );
      } else {
        setResult({
          file: new File([blob], `${fileStem(outputName)}.pdf`, {
            type: "application/pdf",
          }),
          smaller: true,
        });
        setMessage(
          appliedMode === mode
            ? "壓縮完成，可以預覽或下載結果。"
            : appliedMode === "low"
              ? "圖片不適用、超出處理限制或沒有產生更小的結果；已採用 PDF 結構壓縮。"
              : "高壓縮沒有比中壓縮更小；已採用較小的中壓縮結果。"
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === "AbortError"
          ? "已取消壓縮。"
          : fileError(error)
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProcessing(false);
    }
  }

  const savedBytes = result?.smaller && file ? file.size - result.file.size : 0;
  const savedPercent =
    file && savedBytes > 0 ? (savedBytes / file.size) * 100 : 0;

  return (
    <div className="workspace-grid">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="compress-heading"
      >
        <div className="card-header file-card-header">
          <div>
            <div className="eyebrow">01 / 選擇檔案</div>
            <h2 id="compress-heading">讓 PDF 更輕巧</h2>
            <p>加入一份 PDF（最多 64 MB、600 頁），再選擇壓縮方式。</p>
          </div>
          {file && (
            <div className="file-list-actions">
              <span className="count-badge">
                <Counter value={1} /> 份檔案
              </span>
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
            </div>
          )}
        </div>

        {!file ? (
          <DropZone multiple={false} onFiles={chooseFile} />
        ) : (
          <>
            <div className="source-file compress-source-file">
              {thumbnail ? (
                <img className="compress-file-preview" src={thumbnail} alt="" />
              ) : (
                <div className="source-file-icon">
                  <PublicIcon name="file-type-pdf" size={22} />
                </div>
              )}
              <div>
                <strong title={file.name}>{file.name}</strong>
                <span>
                  <ByteCounter size={file.size} />
                  {pageCount !== null && (
                    <>
                      {" · "}
                      <Counter value={pageCount} /> 頁
                    </>
                  )}
                </span>
              </div>
              <button
                type="button"
                className="button button--small button--outline"
                onClick={() => setPreviewFile(file)}
                disabled={loading || Boolean(loadError)}
              >
                <PublicIcon name="eye" size={15} />
                預覽
              </button>
            </div>
            {loading && <div className="loading-panel">正在讀取 PDF…</div>}
            {loadError && (
              <p className="status-message" role="alert">
                {loadError}
              </p>
            )}
          </>
        )}

        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />{" "}
          檔案只在你的瀏覽器中處理，不會上傳。
        </div>
      </section>

      <aside
        className="workspace-card output-card compress-output-card"
        aria-labelledby="compress-options-heading"
      >
        <div className="compress-options">
          <div className="eyebrow">02 / 壓縮與匯出</div>
          <h2 id="compress-options-heading">設定壓縮方式</h2>
          <p>選擇強度，文字與向量內容會保留；完成後可預覽結果再下載。</p>
          <FormControl className="compress-mode-field" fullWidth>
            <InputLabel id="compress-mode-label" shrink>
              壓縮方式
            </InputLabel>
            <Select
              id="compress-mode"
              labelId="compress-mode-label"
              label="壓縮方式"
              className="compress-mode-select"
              variant="outlined"
              value={mode}
              onChange={(event) =>
                chooseMode(event.target.value as CompressionMode)
              }
              disabled={processing}
              renderValue={(selected) => {
                const details = compressionModes[selected as CompressionMode];
                return (
                  <span className="compress-mode-content">
                    <strong>{details.label}</strong>
                    <small>{details.description}</small>
                  </span>
                );
              }}
              MenuProps={{
                disableScrollLock: true,
                slotProps: { paper: { className: "compress-mode-menu" } },
              }}
            >
              {(["high", "medium", "low"] as const).map((value) => (
                <MenuItem key={value} value={value}>
                  <span className="compress-mode-content">
                    <strong>{compressionModes[value].label}</strong>
                    <small>{compressionModes[value].description}</small>
                  </span>
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </div>
        <div className="output-stats">
          <div>
            <span>原始大小</span>
            <strong>{file ? <ByteCounter size={file.size} /> : "—"}</strong>
          </div>
          <div>
            <span>壓縮後</span>
            <strong>
              {result ? <ByteCounter size={result.file.size} /> : "—"}
            </strong>
          </div>
          <div>
            <span>縮小幅度</span>
            <strong>
              {result ? (
                <>
                  <Counter value={savedPercent} fractionDigits={1} />%
                </>
              ) : (
                "—"
              )}
            </strong>
          </div>
        </div>
        <OutputFilenameField
          id="compress-name"
          value={outputName}
          onChange={setOutputName}
          defaultName={
            file ? `${fileStem(file.name)}-compressed.pdf` : "compressed.pdf"
          }
          disabled={processing}
          placeholder="compressed"
        />
        <button
          type="button"
          className="button button--accent button--full"
          disabled={
            !file ||
            pageCount === null ||
            loading ||
            Boolean(loadError) ||
            processing
          }
          onClick={handleCompress}
        >
          <PublicIcon name="compress" size={18} />
          {processing ? "正在壓縮 PDF…" : "開始壓縮 PDF"}
        </button>
        {processing && (
          <button
            type="button"
            className="button button--outline button--full compress-cancel"
            onClick={() => controllerRef.current?.abort()}
          >
            取消
          </button>
        )}
        {result && (
          <div className="compress-result-actions">
            <button
              type="button"
              className="button button--outline button--full"
              onClick={() => setPreviewFile(result.file)}
            >
              <PublicIcon name="eye" size={18} />
              預覽{result.smaller ? "壓縮結果" : "原始檔"}
            </button>
            {result.smaller && (
              <button
                type="button"
                className="button button--dark button--full"
                onClick={(event) => {
                  saveBlob(result.file, `${fileStem(outputName)}.pdf`);
                  fireButtonConfetti(event.currentTarget);
                }}
              >
                <PublicIcon name="download" size={18} />
                下載壓縮後 PDF
              </button>
            )}
          </div>
        )}
        <p className="encryption-note">
          若原檔只有編輯權限限制，輸出檔不會保留原加密設定。
        </p>
        {message && (
          <p
            className={`status-message ${result?.smaller ? "status-message--success" : ""}`}
            role="status"
          >
            {message}
          </p>
        )}
      </aside>
      {previewFile && (
        <PdfPreviewDialog
          key={previewFile.name}
          file={previewFile}
          maxImagePixels={COMPRESSION_LIMITS.imagePixels}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
