import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import PublicIcon from "./PublicIcon";
import type { ViewMode } from "./useViewMode";

import "./ViewModeToggle.css";

const viewModes = {
  list: { label: "列表", icon: "list", next: "grid" },
  grid: { label: "大網格", icon: "grid-3x3", next: "grid-medium" },
  "grid-medium": { label: "中網格", icon: "grid-4x4", next: "grid-small" },
  "grid-small": { label: "小網格", icon: "grid-5x5", next: "list" },
} as const;

export default function ViewModeToggle({
  value,
  onChange,
  disabled = false,
}: {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
  disabled?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const { label, icon, next: nextValue } = viewModes[value];
  const nextLabel = viewModes[nextValue].label;
  const hidden = {
    opacity: 0,
    scale: reduceMotion ? 1 : 0.25,
    filter: reduceMotion ? "blur(0px)" : "blur(4px)",
  };

  return (
    <button
      type="button"
      className="view-mode-toggle"
      aria-label={`目前為${label}顯示，切換為${nextLabel}顯示`}
      title={`切換為${nextLabel}顯示`}
      disabled={disabled}
      onClick={() => onChange(nextValue)}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          className="view-mode-toggle-content"
          aria-hidden="true"
          initial={hidden}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={hidden}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { type: "spring", duration: 0.3, bounce: 0 }
          }
        >
          <PublicIcon name={icon} size={15} />
          {label}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
