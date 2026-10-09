import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { RotateCw } from "lucide-react";

import Counter, { ByteCounter } from "../../../shared/ui/Counter";
import PdfCollectionItem from "../../../shared/ui/PdfCollectionItem";
import PublicIcon from "../../../shared/ui/PublicIcon";
import type { ViewMode } from "../../../shared/ui/useViewMode";
import { displayedSize, type ImageItem } from "../lib/imageSource";

export default function SortableImage({
  item,
  position,
  viewMode,
  disabled,
  sorting,
  onPreview,
  onRotate,
  onRemove,
}: {
  item: ImageItem;
  position: number;
  viewMode: ViewMode;
  disabled: boolean;
  sorting: boolean;
  onPreview: () => void;
  onRotate: () => void;
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
  const size = item.info ? displayedSize(item.info, item.rotation) : null;
  return (
    <PdfCollectionItem
      rootRef={setNodeRef}
      viewMode={viewMode}
      position={<Counter value={position + 1} minimumIntegerDigits={2} />}
      thumbnail={item.thumbnail}
      thumbnailAspectRatio={size ? size.width / size.height : undefined}
      title={item.file.name}
      titleStatus={item.rotation ? `已旋轉 ${item.rotation}°` : undefined}
      metadata={
        <>
          <ByteCounter size={item.file.size} />
          {item.loading
            ? " · 讀取中…"
            : item.error
              ? ` · ${item.error}`
              : size
                ? ` · ${size.width} × ${size.height} px`
                : ""}
        </>
      }
      activateLabel={`拖曳排序 ${item.file.name}`}
      activateTitle="拖曳調整順序"
      previewLabel={`預覽 ${item.file.name}`}
      previewTitle="預覽圖片"
      onPreview={onPreview}
      mainDragProps={{ ...attributes, ...listeners }}
      mainDisabled={disabled}
      previewDisabled={disabled || sorting || item.loading || !!item.error}
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
      trailingActions={
        <>
          <button
            type="button"
            className="icon-button"
            onClick={onRotate}
            disabled={disabled || sorting || item.loading || !!item.error}
            aria-label={`向右旋轉 ${item.file.name}`}
            title="向右旋轉 90°"
          >
            <RotateCw size={17} />
          </button>
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
        </>
      }
    />
  );
}
