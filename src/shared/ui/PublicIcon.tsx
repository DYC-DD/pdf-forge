import type { CSSProperties } from "react";

export type PublicIconName =
  | "arrow-narrow-up-dashed"
  | "arrow-up-right"
  | "check"
  | "checks"
  | "cloud-off"
  | "compress"
  | "download"
  | "eye"
  | "feather"
  | "file-type-pdf"
  | "files"
  | "grip-horizontal"
  | "lock"
  | "plus"
  | "scissors"
  | "shield-check"
  | "shield-lock"
  | "trash"
  | "upload"
  | "x";

export default function PublicIcon({
  name,
  size = 24,
  className = "",
  rotate = 0,
}: {
  name: PublicIconName;
  size?: number;
  className?: string;
  rotate?: number;
}) {
  const image = `url("${import.meta.env.BASE_URL}icons/${name}.svg")`;

  return (
    <i
      className={`public-icon ${className}`.trim()}
      aria-hidden="true"
      style={
        {
          "--icon-size": `${size}px`,
          maskImage: image,
          WebkitMaskImage: image,
          transform: rotate ? `rotate(${rotate}deg)` : undefined,
        } as CSSProperties
      }
    />
  );
}
