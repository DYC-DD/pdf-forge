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
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useState } from "react";

import { fileStem, formatBytes, saveBlob } from "../../shared/files/file";
import { fileError } from "../../shared/pdf/errors";
import { inspectPdf } from "../../shared/pdf/preview";
import DropZone from "../../shared/ui/DropZone";
import PdfPreviewDialog from "../../shared/ui/PdfPreviewDialog";
import PublicIcon from "../../shared/ui/PublicIcon";
import SortableFileRow from "./components/SortableFileRow";
import { mergePdfs } from "./lib/mergePdfs";
import type { MergeItem } from "./types";

export default function MergeWorkspace() {
  const [items, setItems] = useState<MergeItem[]>([]);
  const [outputName, setOutputName] = useState("merged.pdf");
  const [message, setMessage] = useState("");
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewProcessing, setPreviewProcessing] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const busy = processing || previewProcessing;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  async function addFiles(files: File[]) {
    if (busy || files.length === 0) return;
    const valid = files.filter((file) => /\.pdf$/i.test(file.name));
    if (valid.length !== files.length) setMessage("已略過非 PDF 檔案。");
    else setMessage("");
    const added = valid.map((file): MergeItem => ({
      id: crypto.randomUUID(),
      file,
      loading: true,
    }));
    setItems((current) => [...current, ...added]);
    for (const item of added) {
      try {
        const info = await inspectPdf(item.file);
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id ? { ...entry, ...info, loading: false } : entry
          )
        );
      } catch (error) {
        setItems((current) =>
          current.map((entry) =>
            entry.id === item.id
              ? { ...entry, error: fileError(error), loading: false }
              : entry
          )
        );
      }
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((current) => {
      const from = current.findIndex((item) => item.id === active.id);
      const to = current.findIndex((item) => item.id === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  }

  function clearFiles() {
    if (busy) return;
    setItems([]);
    setPreviewFile(null);
    setMessage("");
    setProgress(0);
    setPreviewProgress(0);
  }

  async function handleMerge() {
    if (
      busy ||
      items.length < 2 ||
      items.some((item) => item.loading || item.error)
    )
      return;
    setMessage("");
    setProgress(0);
    setProcessing(true);
    try {
      const blob = await mergePdfs(
        items.map((item) => item.file),
        setProgress
      );
      saveBlob(blob, `${fileStem(outputName)}.pdf`);
      setMessage(`合併完成，已下載 ${formatBytes(blob.size)} 的 PDF。`);
    } catch (error) {
      setMessage(fileError(error));
    } finally {
      setProcessing(false);
    }
  }

  async function handlePreviewOutput() {
    if (
      busy ||
      items.length < 2 ||
      items.some((item) => item.loading || item.error)
    )
      return;
    setMessage("");
    setPreviewProgress(0);
    setPreviewProcessing(true);
    try {
      const blob = await mergePdfs(
        items.map((item) => item.file),
        setPreviewProgress
      );
      setPreviewFile(
        new File([blob], `${fileStem(outputName)}.pdf`, {
          type: "application/pdf",
        })
      );
    } catch (error) {
      setMessage(fileError(error));
    } finally {
      setPreviewProcessing(false);
    }
  }

  const totalPages = items.reduce(
    (sum, item) => sum + (item.pageCount ?? 0),
    0
  );
  const canMerge =
    items.length >= 2 && items.every((item) => !item.loading && !item.error);
  const fileLabel = (id: string | number) =>
    items.find((item) => item.id === id)?.file.name ?? "檔案";

  return (
    <div className="workspace-grid">
      <section
        className="workspace-card workspace-main"
        aria-labelledby="merge-heading"
      >
        <div className="card-header merge-card-header">
          <div>
            <div className="eyebrow">01 / 排列檔案</div>
            <h2 id="merge-heading">依你想要的順序合併</h2>
            <p>點選縮圖或檔名預覽；拖曳右側空白處或把手調整順序。</p>
          </div>
          {items.length > 0 && (
            <div className="file-list-actions">
              <button
                type="button"
                className="clear-files-button"
                onClick={clearFiles}
                disabled={busy}
                aria-label="清除全部 PDF"
              >
                <PublicIcon name="trash" size={15} />
                清除全部
              </button>
              <span className="count-badge">{items.length} 份檔案</span>
            </div>
          )}
        </div>
        {items.length === 0 ? (
          <DropZone multiple onFiles={addFiles} />
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              accessibility={{
                screenReaderInstructions: {
                  draggable:
                    "按空白鍵開始排序，使用方向鍵移動，再按空白鍵放下。",
                },
                announcements: {
                  onDragStart: ({ active }) =>
                    `開始移動 ${fileLabel(active.id)}。`,
                  onDragOver: ({ active, over }) =>
                    over
                      ? `${fileLabel(active.id)} 移到 ${fileLabel(
                          over.id
                        )} 的位置。`
                      : undefined,
                  onDragEnd: ({ active, over }) =>
                    over
                      ? `${fileLabel(active.id)} 已放到 ${fileLabel(
                          over.id
                        )} 的位置。`
                      : "已取消排序。",
                  onDragCancel: () => "已取消排序。",
                },
              }}
            >
              <SortableContext
                items={items.map((item) => item.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="file-list">
                  {items.map((item, index) => (
                    <SortableFileRow
                      key={item.id}
                      item={item}
                      position={index}
                      disabled={busy}
                      onPreview={() => setPreviewFile(item.file)}
                      onRemove={() => {
                        if (previewFile === item.file) setPreviewFile(null);
                        setItems((current) =>
                          current.filter((entry) => entry.id !== item.id)
                        );
                      }}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {!busy && <DropZone multiple compact onFiles={addFiles} />}
          </>
        )}
        <div className="privacy-note">
          <PublicIcon name="lock" size={16} />{" "}
          檔案只在你的瀏覽器中處理，不會上傳。
        </div>
      </section>

      <aside
        className="workspace-card output-card"
        aria-labelledby="merge-output-heading"
      >
        <div className="eyebrow">02 / 匯出結果</div>
        <h2 id="merge-output-heading">準備好輸出？</h2>
        <p>合併後會得到一份 PDF，頁面依左側檔案順序排列。</p>
        <div className="output-stats">
          <div>
            <span>PDF 檔案</span>
            <strong>{items.length} 份</strong>
          </div>
          <div>
            <span>合計頁數</span>
            <strong>{totalPages} 頁</strong>
          </div>
          <div>
            <span>原始大小</span>
            <strong>
              {formatBytes(
                items.reduce((sum, item) => sum + item.file.size, 0)
              )}
            </strong>
          </div>
        </div>
        <label className="field-label" htmlFor="merge-name">
          輸出檔名
        </label>
        <div className="filename-field">
          <input
            id="merge-name"
            value={outputName.replace(/\.pdf$/i, "")}
            onChange={(event) => setOutputName(event.target.value)}
            placeholder="merged"
          />
          <span>.pdf</span>
        </div>
        <button
          className="button button--outline button--full output-preview-button"
          disabled={!canMerge || busy}
          onClick={handlePreviewOutput}
        >
          <PublicIcon name="eye" size={18} />
          {previewProcessing
            ? `產生預覽中 ${previewProgress}/${items.length}`
            : "預覽合併結果"}
        </button>
        <button
          className="button button--accent button--full"
          disabled={!canMerge || busy}
          onClick={handleMerge}
        >
          <PublicIcon name="download" size={18} />
          {processing ? `處理中 ${progress}/${items.length}` : "合併並下載 PDF"}
          {!processing && (
            <PublicIcon name="arrow-narrow-up-dashed" size={17} rotate={90} />
          )}
        </button>
        <p className="encryption-note">
          若原檔只有編輯權限限制，輸出檔不會保留原加密設定。
        </p>
        {!canMerge && <p className="helper-text">請加入至少兩份有效的 PDF。</p>}
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
      {previewFile && (
        <PdfPreviewDialog
          key={previewFile.name}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}
