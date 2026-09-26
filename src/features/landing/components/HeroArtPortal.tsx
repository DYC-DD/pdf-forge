import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = { left: number; top: number; scale: number };

export default function HeroArtPortal({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    let frame: number | null = null;
    const syncPlacement = () => {
      frame = null;
      const rect = anchor.getBoundingClientRect();
      const next = {
        left: rect.left,
        top: rect.top,
        scale: rect.width / anchor.offsetWidth,
      };
      setPlacement((current) =>
        current?.left === next.left &&
        current.top === next.top &&
        current.scale === next.scale
          ? current
          : next
      );
    };
    const schedulePlacement = () => {
      if (frame === null) frame = requestAnimationFrame(syncPlacement);
    };

    syncPlacement();
    const observer = new ResizeObserver(schedulePlacement);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("scroll", schedulePlacement, true);
    window.addEventListener("resize", schedulePlacement);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedulePlacement, true);
      window.removeEventListener("resize", schedulePlacement);
    };
  }, []);

  const overlayStyle: CSSProperties | undefined = placement
    ? {
        position: "fixed",
        left: placement.left,
        top: placement.top,
        transform: `scale(${placement.scale})`,
        transformOrigin: "top left",
      }
    : undefined;

  return (
    <>
      <div className="hero-art" aria-hidden="true">
        <div className="hero-art-canvas hero-art-anchor" ref={anchorRef} />
      </div>
      {placement &&
        createPortal(
          <div
            className="hero-art-canvas hero-art-overlay"
            role="group"
            aria-label="可拖曳並翻面的 PDF 卡片"
            style={overlayStyle}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
