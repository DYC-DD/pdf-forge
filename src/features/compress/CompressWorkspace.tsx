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
import PdfCollectionItem from "../../shared/ui/PdfCollectionItem";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import useViewMode from "../../shared/ui/useViewMode";
import ViewModeToggle from "../../shared/ui/ViewModeToggle";
import ImagePreviewDialog from "../convert/components/ImagePreviewDialog";
import { rasterImage } from "../convert/lib/imageCanvas";
import { conversionStem, displayedSize } from "../convert/lib/imageSource";
import {
  detectCompressionSource,
  type CompressionSource,
} from "./lib/compressionSource";
import { compressPdf } from "./lib/compressPdf";
import { runImageCompression } from "./lib/runImageCompression";
import type { CompressionMode } from "./types";

type CompressionResult = {
  file: File;
  smaller: boolean;
};

const pdfCompressionModes: Record<
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

const jpgCompressionModes = {
  high: {
    label: "高壓縮",
    description: "降低圖片品質，最長邊縮至 1,920 像素；不放大圖片。",
  },
  medium: {
    label: "中壓縮",
    description: "調整圖片品質，保留原始解析度；照片細節可能降低。",
  },
  low: {
    label: "低壓縮",
    description: "移除文字註解等附加資料，不重新編碼或改變尺寸。",
  },
};
const pngCompressionModes = {
  high: {
    label: "高壓縮",
    description: "最長邊縮至 1,920 像素，保留比例與透明背景；不放大圖片。",
  },
  medium: {
    label: "中壓縮",
    description: "無損最佳化圖片編碼，保留原始解析度與透明背景。",
  },
  low: {
    label: "低壓縮",
    description: "移除文字註解等附加資料，不重新編碼或改變尺寸。",
  },
};

export default function CompressWorkspace() {
  const [source, setSource] = useState<CompressionSource | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [viewMode, setViewMode] = useViewMode();
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [thumbnail, setThumbnail] = useState("");
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<CompressionMode>("medium");
  const [outputName, setOutputName] = useState("compressed.pdf");
  const [result, setResult] = useState<CompressionResult | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const file = source?.file ?? null;
  const isImage = source?.kind === "image";
  const extension = source?.kind === "image" ? source.info.format : "pdf";
  const fileType = isImage ? "圖片" : "PDF";
  const defaultName = file
    ? `${conversionStem(file.name)}-compressed.${extension}`
    : "compressed.pdf";
  const compressionModes =
    source?.kind === "image"
      ? source.info.format === "png"
        ? pngCompressionModes
        : jpgCompressionModes
      : pdfCompressionModes;

  useEffect(() => {
    if (!source) return;
    const abort = new AbortController();
    let thumbnailUrl = "";
    setLoading(true);
    const inspect =
      source.kind === "image"
        ? rasterImage(
            source.file,
            source.info,
            0,
            "image/png",
            abort.signal,
            720
          ).then((blob) => {
            if (abort.signal.aborted) return;
            thumbnailUrl = URL.createObjectURL(blob);
            const size = displayedSize(source.info);
            setThumbnail(thumbnailUrl);
            setThumbnailAspectRatio(size.width / size.height);
          })
        : inspectPdf(
            source.file,
            pdfPageCountError,
            COMPRESSION_LIMITS.imagePixels
          ).then((info) => {
            if (abort.signal.aborted) return;
            setPageCount(info.pageCount);
            setThumbnail(info.thumbnail);
            setThumbnailAspectRatio(info.thumbnailAspectRatio);
          });
    inspect
      .catch((error) => {
        if (!abort.signal.aborted) setLoadError(fileError(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
    };
  }, [source]);

  useEffect(
    () => () => {
      generation.current++;
      controllerRef.current?.abort();
    },
    []
  );

  async function chooseFile(files: File[]) {
    if (processing || detecting || files.length === 0) return;
    const current = ++generation.current;
    setDetecting(true);
    setMessage("");
    try {
      const chosen = await detectCompressionSource(files);
      if (current !== generation.current) return;
      if (chosen.kind === "pdf") {
        const error = pdfFileError(chosen.file);
        if (error) throw new Error(error);
      }
      setSource(chosen);
      setLoading(true);
      setPageCount(null);
      setThumbnail("");
      setThumbnailAspectRatio(undefined);
      setLoadError("");
      setResult(null);
      setPreviewFile(null);
      const format = chosen.kind === "image" ? chosen.info.format : "pdf";
      setOutputName(`${conversionStem(chosen.file.name)}-compressed.${format}`);
    } catch (error) {
      if (current === generation.current) setMessage(fileError(error));
    } finally {
      if (current === generation.current) setDetecting(false);
    }
  }

  function clearFile() {
    if (processing) return;
    generation.current++;
    setDetecting(false);
    setSource(null);
    setPageCount(null);
    setThumbnail("");
    setThumbnailAspectRatio(undefined);
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
    if (
      !file ||
      (!isImage && pageCount === null) ||
      loading ||
      loadError ||
      processing ||
      controllerRef.current
    )
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setProcessing(true);
    setResult(null);
    setMessage("");
    try {
      const { blob, appliedMode } = await (isImage
        ? runImageCompression(file, mode, controller.signal)
        : compressPdf(file, mode, controller.signal));
      if (controller.signal.aborted) return;
      if (blob.size >= file.size) {
        setResult({ file, smaller: false });
        setMessage(
          isImage
            ? "目前模式無法再縮小這張圖片；已保留原始檔案。"
            : "目前模式無法再縮小這份 PDF；內容可能已壓縮，或圖片格式不適用。"
        );
      } else {
        setResult({
          file: new File(
            [blob],
            `${isImage ? conversionStem(outputName) : fileStem(outputName)}.${extension}`,
            {
              type: isImage
                ? extension === "jpg"
                  ? "image/jpeg"
                  : "image/png"
                : "application/pdf",
            }
          ),
          smaller: true,
        });
        setMessage(
          isImage && appliedMode !== mode
            ? "壓縮完成；已採用檔案較小、畫質損失較少的結果，可預覽或下載。"
            : appliedMode === mode
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
            <h2 id="compress-heading">
              讓{fileType === "PDF" ? " PDF " : "圖片"}更輕巧
            </h2>
            <p>
              {isImage
                ? "一次壓縮一張圖片，保留原格式；單張最多 64 MB、4,000 萬像素。"
                : "加入一份 PDF 或圖片，自動辨識壓縮模式；PDF 最多 64 MB、600 頁。"}
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
                  disabled={processing}
                  aria-label={`清除${fileType === "PDF" ? " PDF" : "圖片"}`}
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
          <DropZone
            multiple={false}
            onFiles={(files) => void chooseFile(files)}
            accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
            label="選擇一份 PDF 或圖片"
            title={detecting ? "正在辨識檔案…" : "拖曳一份 PDF 或圖片到這裡"}
            description="點擊任意位置選取檔案，一次只能加入一個檔案"
            disabled={detecting}
          />
        ) : (
          <>
            <div className={`pdf-collection pdf-collection--${viewMode}`}>
              <PdfCollectionItem
                viewMode={viewMode}
                position={<Counter value={1} minimumIntegerDigits={2} />}
                thumbnail={thumbnail}
                thumbnailAspectRatio={thumbnailAspectRatio}
                title={file.name}
                metadata={
                  <>
                    <ByteCounter size={file.size} />
                    {source?.kind === "image" && (
                      <>
                        {" · "}
                        {displayedSize(source.info).width} ×{" "}
                        {displayedSize(source.info).height} px
                      </>
                    )}
                    {pageCount !== null && (
                      <>
                        {" · "}
                        <Counter value={pageCount} /> 頁
                      </>
                    )}
                  </>
                }
                activateLabel={`預覽 ${file.name}`}
                activateTitle={`預覽${fileType}`}
                previewTitle={`預覽${fileType}`}
                previewLabel={`預覽 ${file.name}`}
                onActivate={() => setPreviewFile(file)}
                onPreview={() => setPreviewFile(file)}
                mainDisabled={loading || Boolean(loadError)}
                previewDisabled={loading || Boolean(loadError)}
                error={Boolean(loadError)}
              />
            </div>
            {loading && (
              <div className="loading-panel">正在讀取{fileType}…</div>
            )}
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
          <p>
            {isImage
              ? "選擇強度，輸出維持原圖片格式；完成後可預覽結果再下載。"
              : "選擇強度，文字與向量內容會保留；完成後可預覽結果再下載。"}
          </p>
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
          defaultName={defaultName}
          extension={extension}
          disabled={processing}
          placeholder="compressed"
        />
        <button
          type="button"
          className="button button--accent button--full"
          disabled={
            !file ||
            (!isImage && pageCount === null) ||
            loading ||
            Boolean(loadError) ||
            processing
          }
          onClick={handleCompress}
        >
          <PublicIcon name="compress" size={18} />
          {processing
            ? `正在壓縮${fileType === "PDF" ? " PDF" : "圖片"}…`
            : `開始壓縮${fileType === "PDF" ? " PDF" : "圖片"}`}
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
                  saveBlob(
                    result.file,
                    `${isImage ? conversionStem(outputName) : fileStem(outputName)}.${extension}`
                  );
                  fireButtonConfetti(event.currentTarget);
                }}
              >
                <PublicIcon name="download" size={18} />
                下載壓縮後{fileType === "PDF" ? " PDF" : "圖片"}
              </button>
            )}
          </div>
        )}
        {!isImage && (
          <p className="encryption-note">
            若原檔只有編輯權限限制，輸出檔不會保留原加密設定。
          </p>
        )}
        {message && (
          <p
            className={`status-message ${result?.smaller ? "status-message--success" : ""}`}
            role="status"
          >
            {message}
          </p>
        )}
      </aside>
      {previewFile &&
        (isImage ? (
          <ImagePreviewDialog
            key={previewFile.name}
            item={{ file: previewFile, rotation: 0 }}
            description={previewFile === file ? "原始圖片預覽" : "壓縮結果預覽"}
            onClose={() => setPreviewFile(null)}
          />
        ) : (
          <PdfPreviewDialog
            key={previewFile.name}
            file={previewFile}
            maxImagePixels={COMPRESSION_LIMITS.imagePixels}
            onClose={() => setPreviewFile(null)}
          />
        ))}
    </div>
  );
}
