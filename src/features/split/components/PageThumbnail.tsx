import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { renderPageThumbnail } from "../../../shared/pdf/preview";
import PublicIcon from "../../../shared/ui/PublicIcon";

export default function PageThumbnail({
  pdf,
  pageNumber,
  selected,
  disabled,
  groupCount,
  onToggle,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  selected: boolean;
  disabled: boolean;
  groupCount: number;
  onToggle: () => void;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
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
    <button
      ref={anchorRef}
      className={`page-tile ${selected ? "page-tile--selected" : ""}`}
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
        <strong>第 {pageNumber} 頁</strong>
        {groupCount > 0 && <span>已加入 {groupCount} 組</span>}
      </div>
    </button>
  );
}
