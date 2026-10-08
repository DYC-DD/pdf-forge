import Checkbox from "@mui/material/Checkbox";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
  Ref,
} from "react";

import PublicIcon from "./PublicIcon";
import type { ViewMode } from "./useViewMode";

import "./PdfCollectionItem.css";

export default function PdfCollectionItem({
  viewMode,
  position,
  thumbnail,
  thumbnailAspectRatio,
  portraitThumbnailFrame = false,
  title,
  titleStatus,
  metadata,
  activateLabel,
  activateTitle,
  previewLabel,
  onActivate,
  onPreview,
  mainDragProps,
  mainDisabled = false,
  previewDisabled = false,
  selected,
  readOnly = false,
  dragging = false,
  error = false,
  actions,
  trailingActions,
  dragRegion,
  rootRef,
  style,
}: {
  viewMode: ViewMode;
  position: ReactNode;
  thumbnail?: string;
  thumbnailAspectRatio?: number;
  portraitThumbnailFrame?: boolean;
  title: string;
  titleStatus?: string;
  metadata?: ReactNode;
  activateLabel: string;
  activateTitle: string;
  previewLabel: string;
  onActivate?: () => void;
  onPreview: () => void;
  mainDragProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  mainDisabled?: boolean;
  previewDisabled?: boolean;
  selected?: boolean;
  readOnly?: boolean;
  dragging?: boolean;
  error?: boolean;
  actions?: ReactNode;
  trailingActions?: ReactNode;
  dragRegion?: ReactNode;
  rootRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}) {
  const isGrid = viewMode !== "list";
  const isCompact = viewMode === "grid-medium" || viewMode === "grid-small";
  const controls = (
    <div className="pdf-item-actions">
      {actions}
      <button
        type="button"
        className="icon-button pdf-item-preview"
        onClick={onPreview}
        disabled={previewDisabled}
        aria-label={previewLabel}
        title="預覽 PDF"
      >
        <PublicIcon name="eye" size={17} />
      </button>
      {selected !== undefined && (
        <Checkbox
          className="pdf-item-select"
          size={isCompact ? "small" : "medium"}
          checked={selected}
          onChange={onActivate}
          slotProps={{ input: { "aria-label": activateLabel } }}
          title={activateTitle}
          disabled={mainDisabled || readOnly}
        />
      )}
      {trailingActions}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`pdf-item pdf-item--${viewMode === "list" ? "list" : "grid"} ${
        isCompact ? "pdf-item--compact" : ""
      } ${
        selected ? "pdf-item--selected" : ""
      } ${readOnly ? "pdf-item--readonly" : ""} ${
        dragging ? "pdf-item--dragging" : ""
      } ${error ? "pdf-item--error" : ""}`}
      style={style}
    >
      {isGrid && (
        <div className="pdf-item-header">
          <span className="pdf-item-number">{position}</span>
          {dragRegion}
          {controls}
        </div>
      )}
      <button
        type="button"
        className={`pdf-item-main${mainDragProps ? " pdf-item-main--draggable" : ""}`}
        onClick={onActivate}
        disabled={mainDisabled}
        aria-pressed={selected}
        aria-label={activateLabel}
        title={activateTitle}
        {...mainDragProps}
      >
        {!isGrid && <span className="pdf-item-number">{position}</span>}
        <span
          className={`pdf-item-image${
            (thumbnailAspectRatio ?? 0) > 1 ? " pdf-item-image--landscape" : ""
          }${portraitThumbnailFrame ? " pdf-item-image--portrait-frame" : ""}`}
          style={
            {
              "--pdf-thumbnail-aspect-ratio": portraitThumbnailFrame
                ? 0.76
                : (thumbnailAspectRatio ?? 0.76),
            } as CSSProperties
          }
        >
          {thumbnail ? (
            <img src={thumbnail} alt="" draggable={false} />
          ) : (
            <PublicIcon name="files" size={24} />
          )}
        </span>
        <span className="pdf-item-info">
          <span
            className={`pdf-item-title${titleStatus ? " pdf-item-title--with-status" : ""}`}
          >
            <strong title={title}>{title}</strong>
            {titleStatus && (
              <span className="pdf-item-status">{titleStatus}</span>
            )}
          </span>
          {metadata != null && (
            <span className="pdf-item-metadata">{metadata}</span>
          )}
        </span>
      </button>
      {!isGrid && (
        <>
          {dragRegion}
          {controls}
        </>
      )}
    </div>
  );
}
