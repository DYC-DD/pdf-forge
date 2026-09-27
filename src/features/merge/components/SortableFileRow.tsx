import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import Counter, { ByteCounter } from "../../../shared/ui/Counter";
import PublicIcon from "../../../shared/ui/PublicIcon";
import type { MergeItem } from "../types";

export default function SortableFileRow({
  item,
  position,
  disabled,
  onPreview,
  onRemove,
}: {
  item: MergeItem;
  position: number;
  disabled: boolean;
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
  return (
    <div
      ref={setNodeRef}
      className={`file-row ${isDragging ? "file-row--dragging" : ""} ${
        item.error ? "file-row--error" : ""
      }`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="file-main"
        onClick={onPreview}
        disabled={disabled || item.loading || !!item.error}
        aria-label={`預覽 ${item.file.name}`}
        title="預覽 PDF"
      >
        <div className="file-index">
          <Counter value={position + 1} minimumIntegerDigits={2} />
        </div>
        <div className="file-preview">
          {item.thumbnail ? (
            <img src={item.thumbnail} alt="" />
          ) : (
            <PublicIcon name="files" size={24} />
          )}
        </div>
        <div className="file-info">
          <strong title={item.file.name}>{item.file.name}</strong>
          <span>
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
          </span>
        </div>
      </button>
      <div
        className="row-drag-region"
        {...listeners}
        aria-hidden="true"
        title="拖曳排序"
      />
      <div className="row-controls">
        <button
          className="icon-button drag-handle"
          {...attributes}
          {...listeners}
          disabled={disabled}
          aria-label={`拖曳排序 ${item.file.name}`}
          title="拖曳排序"
        >
          <PublicIcon name="grip-horizontal" size={19} rotate={90} />
        </button>
        <button
          className="icon-button icon-button--danger"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`移除 ${item.file.name}`}
          title="移除"
        >
          <PublicIcon name="x" size={17} />
        </button>
      </div>
    </div>
  );
}
