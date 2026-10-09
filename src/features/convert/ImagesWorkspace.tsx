import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import { useEffect, useRef, useState } from "react";

import { saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { fireButtonConfetti } from "../../shared/ui/buttonConfetti";
import Counter from "../../shared/ui/Counter";
import DropZone from "../../shared/ui/DropZone";
import OutputFilenameField from "../../shared/ui/OutputFilenameField";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import useViewMode from "../../shared/ui/useViewMode";
import ViewModeToggle from "../../shared/ui/ViewModeToggle";
import ImagePreviewDialog from "./components/ImagePreviewDialog";
import SortableImage from "./components/SortableImage";
import type { ImageOutputFormat } from "./lib/convertImages";
import { rasterImage } from "./lib/imageCanvas";
import {
  conversionStem,
  detectSources,
  imageInputsError,
  inspectImageBytes,
  type ImageItem,
} from "./lib/imageSource";
import { runImageConversion } from "./lib/runImageConversion";

const formats: { value: ImageOutputFormat; label: string; hint: string }[] = [
  {
    value: "pdf",
    label: "PDF：適用於彙整文件與列印",
    hint: "一張圖片一頁，依排列順序合成一份 PDF；保留原始像素與圖片比例。",
  },
  {
    value: "jpg",
    label: "JPG：適用於照片與日常分享",
    hint: "保留原始解析度，以最高畫質輸出；透明區域會補白底。",
  },
  {
    value: "png",
    label: "PNG：適用於文字、圖表與透明圖片",
    hint: "無損輸出，保留原始解析度、PNG 位元深度與透明背景。",
  },
  {
    value: "svg",
    label: "SVG：嵌入圖片，適用於 SVG 排版",
    hint: "嵌入完整圖片，保留原始解析度與透明背景；不會轉為向量路徑。",
  },
  {
    value: "webp",
    label: "WEBP：適用於網頁圖片與透明素材",
    hint: "無損編碼，保留原始解析度與透明背景；16 位元圖片會轉為 WEBP 支援的 8 位元。",
  },
];
const makeItem = (file: File): ImageItem => ({
  id: crypto.randomUUID(),
  file,
  rotation: 0,
  loading: true,
});

export default function ImagesWorkspace({
  initialFiles,
  onClear,
}: {
  initialFiles: File[];
  onClear: () => void;
}) {
  const [items, setItems] = useState<ImageItem[]>(() =>
    initialFiles.map(makeItem)
  );
  const [viewMode, setViewMode] = useViewMode();
  const [format, setFormat] = useState<ImageOutputFormat>("pdf");
  const [outputName, setOutputName] = useState(
    initialFiles.length === 1
      ? conversionStem(initialFiles[0].name)
      : "converted"
  );
  const [processing, setProcessing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [packing, setPacking] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewPdf, setPreviewPdf] = useState<File | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const assets = useRef(new Set<string>());
  const busy = processing || previewing || adding;
  const ready =
    items.length > 0 && items.every((item) => !item.loading && !item.error);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      for (const url of assets.current) URL.revokeObjectURL(url);
      assets.current.clear();
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    const pending = itemsRef.current.filter(
      (item) =>
        item.loading || (item.thumbnail && !assets.current.has(item.thumbnail))
    );
    void (async () => {
      for (const item of pending) {
        if (abort.signal.aborted) break;
        try {
          const info = inspectImageBytes(
            new Uint8Array(await item.file.arrayBuffer())
          );
          const thumbnail = await rasterImage(
            item.file,
            info,
            item.rotation,
            "image/png",
            abort.signal,
            720
          );
          if (abort.signal.aborted) break;
          const url = URL.createObjectURL(thumbnail);
          assets.current.add(url);
          setItems((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, info, thumbnail: url, loading: false }
                : entry
            )
          );
        } catch (error) {
          if (!abort.signal.aborted)
            setItems((current) =>
              current.map((entry) =>
                entry.id === item.id
                  ? { ...entry, loading: false, error: fileError(error) }
                  : entry
              )
            );
        }
      }
    })();
    return () => abort.abort();
  }, [initialFiles]);

  async function addFiles(files: File[]) {
    if (busy || !files.length) return;
    setAdding(true);
    setMessage("");
    setSuccess(false);
    try {
      if ((await detectSources(files)) !== "images")
        throw new Error("目前是圖片模式，請先清空檔案再加入 PDF。");
      const error = imageInputsError([
        ...itemsRef.current.map((item) => item.file),
        ...files,
      ]);
      if (error) throw new Error(error);
      const added = files.map(makeItem);
      if (!mounted.current) return;
      setItems((current) => [...current, ...added]);
      for (const item of added) {
        if (!mounted.current) return;
        try {
          const info = inspectImageBytes(
            new Uint8Array(await item.file.arrayBuffer())
          );
          const thumbnail = await rasterImage(
            item.file,
            info,
            0,
            "image/png",
            undefined,
            720
          );
          if (!mounted.current) return;
          const url = URL.createObjectURL(thumbnail);
          assets.current.add(url);
          setItems((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, info, thumbnail: url, loading: false }
                : entry
            )
          );
        } catch (error) {
          if (mounted.current)
            setItems((current) =>
              current.map((entry) =>
                entry.id === item.id
                  ? { ...entry, loading: false, error: fileError(error) }
                  : entry
              )
            );
        }
      }
    } catch (error) {
      if (mounted.current) setMessage(fileError(error));
    } finally {
      if (mounted.current) setAdding(false);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setSorting(false);
    if (!event.over || event.active.id === event.over.id) return;
    setItems((current) => {
      const from = current.findIndex((item) => item.id === event.active.id);
      const to = current.findIndex((item) => item.id === event.over?.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
    setMessage("");
    setSuccess(false);
  }

  async function rotate(item: ImageItem) {
    if (busy || !item.info) return;
    const rotation = (item.rotation + 90) % 360;
    setAdding(true);
    setMessage("");
    setSuccess(false);
    try {
      const blob = await rasterImage(
        item.file,
        item.info,
        rotation,
        "image/png",
        undefined,
        720
      );
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      assets.current.add(url);
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, rotation, thumbnail: url } : entry
        )
      );
      if (item.thumbnail) {
        URL.revokeObjectURL(item.thumbnail);
        assets.current.delete(item.thumbnail);
      }
    } catch (error) {
      if (mounted.current) setMessage(fileError(error));
    } finally {
      if (mounted.current) setAdding(false);
    }
  }

  async function exportImages(preview = false) {
    if (busy || !ready || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setProgress(0);
    setPacking(null);
    setMessage("");
    setSuccess(false);
    if (preview) setPreviewing(true);
    else setProcessing(true);
    try {
      const result = await runImageConversion(
        items.map(({ file, rotation }) => ({ file, rotation })),
        {
          format: preview ? "pdf" : format,
          outputName,
          signal: abort.signal,
          onProgress: setProgress,
          onPackingProgress: setPacking,
        }
      );
      if (abort.signal.aborted || !mounted.current) return;
      if (preview)
        setPreviewPdf(
          new File([result.blob], result.filename, { type: "application/pdf" })
        );
      else {
        saveBlob(result.blob, result.filename);
        setSuccess(true);
        setMessage(`完成！已下載 ${result.filename}。`);
      }
    } catch (error) {
      if (mounted.current)
        setMessage(
          error instanceof Error && error.name === "AbortError"
            ? "已取消轉換。"
            : fileError(error)
        );
    } finally {
      if (controller.current === abort) controller.current = null;
      if (mounted.current) {
        setProcessing(false);
        setPreviewing(false);
      }
    }
  }

  const selectedFormat = formats.find((option) => option.value === format)!;
  const extension = format !== "pdf" && items.length > 1 ? "zip" : format;
  const previewItem = items.find((item) => item.id === previewId);
  const fileLabel = (id: string | number) =>
    items.find((item) => item.id === id)?.file.name ?? "圖片";
  return (
    <div className="workspace-grid">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="images-heading"
      >
        <div className="card-header file-card-header">
          <div>
            <div className="eyebrow">01 / 整理圖片</div>
            <h2 id="images-heading">把圖片變成需要的格式</h2>
            <p>拖曳調整順序，點眼睛預覽，旋轉圖示可轉動圖片。</p>
          </div>
          <div className="file-list-actions">
            <span className="count-badge">
              <Counter value={items.length} /> 張圖片
            </span>
            <div className="file-list-action-buttons">
              <button
                type="button"
                className="clear-files-button"
                disabled={busy}
                onClick={onClear}
                aria-label="清除圖片"
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
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setSorting(true)}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setSorting(false)}
          accessibility={{
            screenReaderInstructions: {
              draggable: "按空白鍵開始排序，使用方向鍵移動，再按空白鍵放下。",
            },
            announcements: {
              onDragStart: ({ active }) => `開始移動 ${fileLabel(active.id)}。`,
              onDragOver: ({ active, over }) =>
                over
                  ? `${fileLabel(active.id)} 移到 ${fileLabel(over.id)} 的位置。`
                  : undefined,
              onDragEnd: ({ active, over }) =>
                over
                  ? `${fileLabel(active.id)} 已放到 ${fileLabel(over.id)} 的位置。`
                  : "已取消排序。",
              onDragCancel: () => "已取消排序。",
            },
          }}
        >
          <SortableContext
            items={items.map((item) => item.id)}
            strategy={
              viewMode === "list"
                ? verticalListSortingStrategy
                : rectSortingStrategy
            }
          >
            <div className={`pdf-collection pdf-collection--${viewMode}`}>
              {items.map((item, index) => (
                <SortableImage
                  key={item.id}
                  item={item}
                  position={index}
                  viewMode={viewMode}
                  disabled={busy}
                  sorting={sorting}
                  onPreview={() => setPreviewId(item.id)}
                  onRotate={() => void rotate(item)}
                  onRemove={() => {
                    if (busy) return;
                    if (item.thumbnail) {
                      URL.revokeObjectURL(item.thumbnail);
                      assets.current.delete(item.thumbnail);
                    }
                    if (items.length === 1) {
                      onClear();
                      return;
                    }
                    setItems((current) =>
                      current.filter((entry) => entry.id !== item.id)
                    );
                    setMessage("");
                    setSuccess(false);
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <DropZone
          multiple
          compact
          onFiles={(files) => void addFiles(files)}
          disabled={busy}
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
          label="繼續加入圖片"
          title={adding ? "正在讀取圖片…" : "繼續加入 JPG／PNG 圖片"}
        />
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />
          檔案只在你的瀏覽器中處理，不會上傳。
        </div>
      </section>
      <aside
        className="workspace-card output-card convert-output-card"
        aria-labelledby="images-output-heading"
      >
        <div className="eyebrow">02 / 轉換與匯出</div>
        <h2 id="images-output-heading">設定輸出格式</h2>
        <p>
          {format === "pdf"
            ? "每張圖片成為一頁，依左側順序合成一份 PDF。"
            : "每張圖片各自轉換，多張圖片會打包為 ZIP。"}
        </p>
        <div className="convert-format">
          <FormControl className="convert-format-field" fullWidth>
            <InputLabel id="images-format-label" shrink>
              輸出格式
            </InputLabel>
            <Select
              id="images-format"
              labelId="images-format-label"
              label="輸出格式"
              aria-describedby="images-format-hint"
              className="convert-format-select"
              variant="outlined"
              value={format}
              disabled={busy}
              onChange={(event) => {
                setFormat(event.target.value as ImageOutputFormat);
                setMessage("");
                setSuccess(false);
                setPreviewPdf(null);
              }}
              MenuProps={{
                disableScrollLock: true,
                slotProps: { paper: { className: "convert-format-menu" } },
              }}
            >
              {formats.map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <p id="images-format-hint" className="convert-format-hint">
            {selectedFormat.hint}
          </p>
        </div>
        <div className="output-divider" />
        <div className="output-count">
          <span>準備輸出</span>
          <strong>
            {format === "pdf" ? (
              <>
                1 份 PDF · <Counter value={items.length} /> 頁
              </>
            ) : (
              <>
                <Counter value={items.length} /> 張 {format.toUpperCase()}
              </>
            )}
          </strong>
        </div>
        <OutputFilenameField
          id="images-name"
          value={outputName}
          onChange={(value) =>
            setOutputName(
              value.replace(/\.(?:pdf|jpe?g|png|svg|webp|zip)$/i, "")
            )
          }
          defaultName="converted"
          placeholder="converted"
          extension={extension}
          disabled={busy}
        />
        {!ready && (
          <p className="status-message" role="status">
            {items.some((item) => item.error)
              ? "請移除無法讀取的圖片，再繼續轉換。"
              : "正在讀取圖片…"}
          </p>
        )}
        {format === "pdf" && (
          <button
            type="button"
            className="button button--outline button--full output-preview-button"
            disabled={busy || !ready}
            onClick={() => void exportImages(true)}
          >
            <PublicIcon name="eye" size={18} />
            {previewing ? `準備預覽 ${progress}/${items.length}` : "預覽 PDF"}
          </button>
        )}
        <button
          type="button"
          className="button button--accent button--full"
          disabled={busy || !ready}
          onClick={(event) => {
            void exportImages();
            fireButtonConfetti(event.currentTarget);
          }}
        >
          <PublicIcon name="download" size={18} />
          {processing
            ? packing === null
              ? `轉換中 ${progress}/${items.length}`
              : `建立 ZIP 中 ${packing}%`
            : extension === "zip"
              ? "下載 ZIP 檔"
              : `下載 ${format.toUpperCase()}${format === "pdf" ? "" : " 圖片"}`}
        </button>
        {(processing || previewing) && (
          <button
            type="button"
            className="button button--outline button--full operation-cancel"
            onClick={() => controller.current?.abort()}
          >
            取消處理
          </button>
        )}
        <p className="encryption-note">
          保留原始解析度，以所選格式的最佳品質輸出。
        </p>
        {message && (
          <p
            className={`status-message ${success ? "status-message--success" : ""}`}
            role="status"
          >
            {message}
          </p>
        )}
      </aside>
      {previewItem && (
        <ImagePreviewDialog
          item={previewItem}
          onClose={() => setPreviewId(null)}
        />
      )}
      {previewPdf && (
        <PdfPreviewDialog
          file={previewPdf}
          onClose={() => setPreviewPdf(null)}
        />
      )}
    </div>
  );
}
