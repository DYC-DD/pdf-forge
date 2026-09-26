import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";

type Point = { x: number; y: number };

type DodgeFieldProps = {
  children: ReactNode;
  className?: string;
  reach?: number;
  radius?: number;
  falloff?: number;
  fleeDuration?: number;
  returnDuration?: number;
  returnBounce?: number;
  axis?: "both" | "x" | "y";
};

const inset = 12;
const deadZone = 6;

const clamp = (value: number, room: number) =>
  Math.min(room, Math.max(-room, value));

// Adapted from React Bits Dodge Field for decorative, non-clickable labels.
export default function DodgeField({
  children,
  className = "",
  reach = 72,
  radius = 120,
  falloff = 2,
  fleeDuration = 130,
  returnDuration = 620,
  returnBounce = 0.1,
  axis = "both",
}: DodgeFieldProps) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<Point | null>(null);
  const bearing = useRef<Point>({ x: 1, y: 0 });
  const room = useRef<Point>({ x: 0, y: 0 });
  const inside = useRef(false);
  const frameId = useRef<number | null>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const field = fieldRef.current;
    const mover = moverRef.current;
    if (!field || !mover) return;

    const measure = () => {
      room.current = {
        x: Math.max(0, (field.clientWidth - mover.offsetWidth) / 2 - inset),
        y: Math.max(0, (field.clientHeight - mover.offsetHeight) / 2 - inset),
      };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    observer.observe(mover);
    return () => observer.disconnect();
  }, []);

  const frame = useCallback(() => {
    frameId.current = null;
    const field = fieldRef.current;
    if (!field) return;

    const rect = field.getBoundingClientRect();
    const scale = rect.width / (field.offsetWidth || rect.width) || 1;
    const dx = pointer.current
      ? (pointer.current.x - rect.left - rect.width / 2) / scale
      : Infinity;
    const dy = pointer.current
      ? (pointer.current.y - rect.top - rect.height / 2) / scale
      : Infinity;
    const distance = Math.hypot(dx, dy);
    const nearby = distance <= radius;
    if (!nearby && !inside.current) return;
    inside.current = nearby;

    if (Number.isFinite(distance) && distance > deadZone) {
      bearing.current =
        axis === "x"
          ? { x: Math.sign(dx) || 1, y: 0 }
          : axis === "y"
            ? { x: 0, y: Math.sign(dy) || 1 }
            : { x: dx / distance, y: dy / distance };
    }
    const flee =
      nearby && !reduceMotion ? (1 - distance / radius) ** falloff : 0;
    const targetX = clamp(-bearing.current.x * flee * reach, room.current.x);
    const targetY = clamp(-bearing.current.y * flee * reach, room.current.y);

    if (reduceMotion) {
      x.jump(0);
      y.jump(0);
      return;
    }

    const config =
      flee > 0
        ? { type: "spring" as const, duration: fleeDuration / 1000, bounce: 0 }
        : {
            type: "spring" as const,
            duration: returnDuration / 1000,
            bounce: returnBounce,
          };
    animate(x, targetX, config);
    animate(y, targetY, config);
  }, [
    axis,
    falloff,
    fleeDuration,
    radius,
    reach,
    reduceMotion,
    returnBounce,
    returnDuration,
    x,
    y,
  ]);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const tick = () => {
      if (frameId.current === null)
        frameId.current = requestAnimationFrame(frame);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer.current = { x: event.clientX, y: event.clientY };
      tick();
    };
    const onLeave = () => {
      pointer.current = null;
      tick();
    };
    const syncPointer = () => {
      if (query.matches) {
        window.addEventListener("pointermove", onMove, { passive: true });
        window.addEventListener("scroll", tick, {
          passive: true,
          capture: true,
        });
        document.addEventListener("pointerleave", onLeave);
        window.addEventListener("blur", onLeave);
      } else {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("scroll", tick, true);
        document.removeEventListener("pointerleave", onLeave);
        window.removeEventListener("blur", onLeave);
        pointer.current = null;
        inside.current = false;
        x.jump(0);
        y.jump(0);
      }
    };

    syncPointer();
    query.addEventListener("change", syncPointer);
    return () => {
      query.removeEventListener("change", syncPointer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", tick, true);
      document.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      if (frameId.current !== null) cancelAnimationFrame(frameId.current);
    };
  }, [frame, x, y]);

  useEffect(() => {
    if (reduceMotion) {
      x.jump(0);
      y.jump(0);
    }
  }, [reduceMotion, x, y]);

  return (
    <div
      ref={fieldRef}
      className={`dodge-field ${className}`}
      aria-hidden="true"
    >
      <motion.div
        ref={moverRef}
        className="dodge-field__mover"
        style={{ x, y }}
      >
        {children}
      </motion.div>
    </div>
  );
}
