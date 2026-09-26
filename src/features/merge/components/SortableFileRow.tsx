import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { formatBytes } from "../../../shared/files/file";
import PublicIcon from "../../../shared/ui/PublicIcon";
import type { MergeItem } from "../types";

export default function SortableFileRow({
  item,
  position,
  total,
  disabled,
  onMove,
  onRemove,
}: {
  item: MergeItem;
  position: number;
  total: number;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
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
      <div className="file-index">{String(position + 1).padStart(2, "0")}</div>
      <div className="file-preview">
        {item.thumbnail ? (
          <img src={item.thumbnail} alt="PDF 首頁預覽" />
        ) : (
          <PublicIcon name="files" size={24} />
        )}
      </div>
      <div className="file-info">
        <strong title={item.file.name}>{item.file.name}</strong>
        <span>
          {formatBytes(item.file.size)}
          {item.loading
            ? " · 讀取中…"
            : item.error
              ? ` · ${item.error}`
              : ` · ${item.pageCount} 頁`}
        </span>
      </div>
      <div className="row-controls">
        <div className="step-controls">
          <button
            className="icon-button"
            onClick={() => onMove(-1)}
            disabled={disabled || position === 0}
            aria-label={`將 ${item.file.name} 上移`}
            title="上移"
          >
            <PublicIcon name="arrow-narrow-up-dashed" size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => onMove(1)}
            disabled={disabled || position === total - 1}
            aria-label={`將 ${item.file.name} 下移`}
            title="下移"
          >
            <PublicIcon name="arrow-narrow-up-dashed" size={16} rotate={180} />
          </button>
        </div>
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
