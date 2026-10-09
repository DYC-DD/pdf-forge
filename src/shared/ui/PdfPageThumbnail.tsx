import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";

import { renderPageThumbnail, type PdfThumbnail } from "../pdf/preview";
import Counter from "./Counter";
import PdfCollectionItem from "./PdfCollectionItem";
import type { ViewMode } from "./useViewMode";

export default function PdfPageThumbnail({
  pdf,
  pageNumber,
  viewMode,
  selected,
  disabled,
  groupCount = 0,
  readOnly = false,
  readOnlyLabel = "已選取",
  onToggle,
  onPreview,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  viewMode: ViewMode;
  selected: boolean;
  disabled: boolean;
  groupCount?: number;
  readOnly?: boolean;
  readOnlyLabel?: string;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<PdfThumbnail>();

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
    renderPageThumbnail(pdf, pageNumber)
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
    <PdfCollectionItem
      rootRef={anchorRef}
      viewMode={viewMode}
      position={
        visible ? (
          <Counter value={pageNumber} minimumIntegerDigits={2} />
        ) : (
          String(pageNumber).padStart(2, "0")
        )
      }
      thumbnail={image?.src}
      thumbnailAspectRatio={image?.aspectRatio}
      title={`第 ${pageNumber} 頁`}
      titleStatus={readOnly ? readOnlyLabel : selected ? "已選取" : "未選取"}
      metadata={
        groupCount > 0 ? (
          <>已加入 {visible ? <Counter value={groupCount} /> : groupCount} 組</>
        ) : undefined
      }
      activateLabel={`第 ${pageNumber} 頁${selected ? "，已選取" : ""}`}
      activateTitle={selected ? "取消選取頁面" : "選取頁面"}
      previewLabel={`預覽第 ${pageNumber} 頁`}
      onActivate={onToggle}
      onPreview={onPreview}
      mainDisabled={disabled}
      selected={selected}
      readOnly={readOnly}
    />
  );
}
