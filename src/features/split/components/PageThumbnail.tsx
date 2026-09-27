import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { renderPageThumbnail } from "../../../shared/pdf/preview";
import Counter from "../../../shared/ui/Counter";
import PublicIcon from "../../../shared/ui/PublicIcon";

export default function PageThumbnail({
  pdf,
  pageNumber,
  selected,
  disabled,
  groupCount,
  onToggle,
  onPreview,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  selected: boolean;
  disabled: boolean;
  groupCount: number;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<string>();

  useEffect(() => {
    const element = anchorRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setImage(undefined);
    renderPageThumbnail(pdf, pageNumber, 156)
      .then((result) => {
        if (!cancelled) setImage(result);
      })
      .catch(() => {
        if (!cancelled) setImage(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, visible]);

  return (
    <div
      ref={anchorRef}
      className={`page-tile ${selected ? "page-tile--selected" : ""}`}
    >
      <button
        type="button"
        className="page-tile-select"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={`第 ${pageNumber} 頁${selected ? "，已選取" : ""}`}
      >
        <div className="page-image">
          {image ? (
            <img src={image} alt="" />
          ) : (
            <div className="page-skeleton">
              <PublicIcon name="files" size={22} />
            </div>
          )}
          <span className="selection-mark">
            <PublicIcon name="check" size={15} />
          </span>
        </div>
        <div className="page-caption">
          <strong>
            第 {visible ? <Counter value={pageNumber} /> : pageNumber} 頁
          </strong>
          {groupCount > 0 && (
            <span>
              已加入 {visible ? <Counter value={groupCount} /> : groupCount} 組
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        className="page-preview-button"
        onClick={onPreview}
        aria-label={`預覽第 ${pageNumber} 頁`}
        title="預覽頁面"
      >
        <PublicIcon name="eye" size={17} />
      </button>
    </div>
  );
}
