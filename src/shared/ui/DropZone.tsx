import { useState, type ChangeEvent, type DragEvent } from "react";

import DotGrid from "./DotGrid";
import PublicIcon from "./PublicIcon";

export default function DropZone({
  multiple,
  onFiles,
  compact = false,
  accept = ".pdf,application/pdf",
  label,
  title,
  description = "點擊任意位置選取檔案，僅支援 .pdf",
  disabled = false,
}: {
  multiple: boolean;
  onFiles: (files: File[]) => void;
  compact?: boolean;
  accept?: string;
  label?: string;
  title?: string;
  description?: string;
  disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    onFiles(Array.from(event.dataTransfer.files));
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    if (disabled) return;
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  return (
    <label
      className={`drop-zone ${compact ? "drop-zone--compact" : ""} ${
        dragging ? "drop-zone--dragging" : ""
      } ${disabled ? "drop-zone--disabled" : ""}`}
      aria-disabled={disabled || undefined}
      onDragEnter={(event) => {
        event.preventDefault();
        if (disabled) return;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <DotGrid
        dotSize={2}
        gap={12}
        baseColor="#34363B"
        activeColor="#809ACC"
        proximity={120}
        shockRadius={250}
        shockStrength={5}
        resistance={750}
        returnDuration={1.5}
      />
      <input
        className="visually-hidden"
        type="file"
        accept={accept}
        disabled={disabled}
        multiple={multiple}
        onChange={handleChange}
        aria-label={label ?? (multiple ? "選擇多份 PDF" : "選擇一份 PDF")}
      />
      <div className="drop-icon">
        <PublicIcon name="upload" size={compact ? 20 : 27} />
      </div>
      <div className="drop-copy">
        <strong>
          {title ??
            (compact
              ? "繼續加入 PDF"
              : `拖曳${multiple ? "多份" : "一份"} PDF 到這裡`)}
        </strong>
        {!compact && <span>{description}</span>}
      </div>
    </label>
  );
}
