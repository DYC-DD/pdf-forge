import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import Counter, { ByteCounter } from "../../../shared/ui/Counter";
import PdfCollectionItem from "../../../shared/ui/PdfCollectionItem";
import PublicIcon from "../../../shared/ui/PublicIcon";
import type { ViewMode } from "../../../shared/ui/useViewMode";
import type { MergeItem } from "../types";

export default function SortableFileRow({
  item,
  position,
  viewMode,
  portraitThumbnailFrame,
  disabled,
  sorting,
  onPreview,
  onRemove,
}: {
  item: MergeItem;
  position: number;
  viewMode: ViewMode;
  portraitThumbnailFrame: boolean;
  disabled: boolean;
  sorting: boolean;
  onPreview: () => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled });
  const previewDisabled = disabled || sorting || item.loading || !!item.error;
  const removeAction = (
    <button
      type="button"
      className="icon-button icon-button--danger"
      onClick={onRemove}
      disabled={disabled || sorting}
      aria-label={`移除 ${item.file.name}`}
      title="移除"
    >
      <PublicIcon name="x" size={17} />
    </button>
  );

  return (
    <PdfCollectionItem
      rootRef={setNodeRef}
      viewMode={viewMode}
      position={<Counter value={position + 1} minimumIntegerDigits={2} />}
      thumbnail={item.thumbnail}
      thumbnailAspectRatio={item.thumbnailAspectRatio}
      portraitThumbnailFrame={portraitThumbnailFrame}
      title={item.file.name}
      metadata={
        <>
          <ByteCounter size={item.file.size} />
          {item.loading ? (
            " · 讀取中…"
          ) : item.error ? (
            ` · ${item.error}`
          ) : (
            <>
              {" · "}
              <Counter value={item.pageCount ?? 0} /> 頁
            </>
          )}
        </>
      }
      activateLabel={`拖曳排序 ${item.file.name}`}
      activateTitle="拖曳調整順序"
      previewLabel={`預覽 ${item.file.name}`}
      onPreview={onPreview}
      mainDragProps={{ ...attributes, ...listeners }}
      mainDisabled={disabled}
      previewDisabled={previewDisabled}
      dragging={isDragging}
      error={!!item.error}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      dragRegion={
        <div
          className="pdf-item-drag-region"
          {...listeners}
          aria-hidden="true"
          title="拖曳排序"
        />
      }
      actions={
        <button
          type="button"
          className="icon-button pdf-item-drag-handle"
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={`拖曳排序 ${item.file.name}`}
          title="拖曳排序"
        >
          <PublicIcon name="grip-horizontal" size={19} rotate={90} />
        </button>
      }
      trailingActions={removeAction}
    />
  );
}
