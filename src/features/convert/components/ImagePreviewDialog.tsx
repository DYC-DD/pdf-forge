import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageItem } from "../lib/imageSource";

export default function ImagePreviewDialog({
  item,
  onClose,
  description = "原始圖片預覽",
}: {
  item: Pick<ImageItem, "file" | "rotation">;
  onClose: () => void;
  description?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const objectUrl = URL.createObjectURL(item.file);
    setUrl(objectUrl);
    const element = dialog.current;
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    element?.showModal();
    return () => {
      element?.close();
      URL.revokeObjectURL(objectUrl);
      document.documentElement.style.overflow = overflow;
    };
  }, [item.file]);
  return createPortal(
    <dialog
      ref={dialog}
      className="convert-image-preview"
      aria-label={`預覽圖片 ${item.file.name}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="convert-image-preview-panel">
        <header className="pdf-preview-header">
          <div className="pdf-preview-title">
            <strong>{item.file.name}</strong>
            <span>
              {description}
              {item.rotation ? ` · 向右旋轉 ${item.rotation}°` : ""}
            </span>
          </div>
          <button
            type="button"
            className="pdf-preview-close"
            aria-label="關閉圖片預覽"
            onClick={onClose}
            autoFocus
          >
            <X size={20} />
          </button>
        </header>
        <div className="convert-image-preview-body">
          {url && (
            <img
              src={url}
              alt={item.file.name}
              className={
                item.rotation % 180
                  ? "convert-image-preview-rotated"
                  : undefined
              }
              style={{ transform: `rotate(${item.rotation}deg)` }}
            />
          )}
        </div>
      </div>
    </dialog>,
    document.body
  );
}
