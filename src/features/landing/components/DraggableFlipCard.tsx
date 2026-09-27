import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type DraggableFlipCardProps = {
  children: ReactNode;
  back: ReactNode;
  className: string;
  label: string;
};

type Point = { x: number; y: number };
type DragSample = Point & { time: number };

const velocityWindowMs = 90;
const inertiaDurationMs = 280;
const maxVelocity = 2.5;

export default function DraggableFlipCard({
  children,
  back,
  className,
  label,
}: DraggableFlipCardProps) {
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isThrowing, setIsThrowing] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const offsetRef = useRef<Point>({ x: 0, y: 0 });
  const inertiaFrame = useRef<number | null>(null);
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    origin: Point;
    moved: boolean;
    ignoredScroll: boolean;
    type: string;
    scale: number;
    samples: DragSample[];
  } | null>(null);

  useEffect(
    () => () => {
      if (inertiaFrame.current !== null)
        cancelAnimationFrame(inertiaFrame.current);
    },
    []
  );

  const updateOffset = (next: Point) => {
    offsetRef.current = next;
    setOffset(next);
  };

  const stopInertia = () => {
    if (inertiaFrame.current !== null)
      cancelAnimationFrame(inertiaFrame.current);
    inertiaFrame.current = null;
    setIsThrowing(false);
  };

  const startInertia = (samples: DragSample[], scale: number) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const latest = samples[samples.length - 1];
    const earliest = samples[0];
    const elapsed = latest.time - earliest.time;
    if (elapsed < 12) return;

    let vx = Math.max(
      -maxVelocity,
      Math.min(maxVelocity, (latest.x - earliest.x) / elapsed / scale)
    );
    let vy = Math.max(
      -maxVelocity,
      Math.min(maxVelocity, (latest.y - earliest.y) / elapsed / scale)
    );
    if (Math.hypot(vx, vy) < 0.08) return;

    setIsThrowing(true);
    let lastTime = performance.now();
    const glide = (now: number) => {
      const elapsedFrame = Math.min(now - lastTime, 32);
      lastTime = now;
      const decay = Math.exp(-elapsedFrame / inertiaDurationMs);
      vx *= decay;
      vy *= decay;
      updateOffset({
        x: offsetRef.current.x + vx * elapsedFrame,
        y: offsetRef.current.y + vy * elapsedFrame,
      });

      if (Math.hypot(vx, vy) > 0.025) {
        inertiaFrame.current = requestAnimationFrame(glide);
      } else {
        inertiaFrame.current = null;
        setIsThrowing(false);
      }
    };
    inertiaFrame.current = requestAnimationFrame(glide);
  };

  const hasHover =
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const showBack = hasHover ? isHovered || isFlipped : isFlipped;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      pointer.current ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;

    stopInertia();
    const canvas = event.currentTarget.parentElement;
    const scale = canvas
      ? canvas.getBoundingClientRect().width / canvas.clientWidth
      : 1;
    pointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: offsetRef.current,
      moved: false,
      ignoredScroll: false,
      type: event.pointerType,
      scale: scale || 1,
      samples: [{ x: event.clientX, y: event.clientY, time: event.timeStamp }],
    };
    if (event.pointerType !== "touch")
      event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;

    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (active.ignoredScroll) return;
    if (!active.moved) {
      if (Math.hypot(dx, dy) < (active.type === "touch" ? 8 : 5)) return;
      if (active.type === "touch") {
        if (Math.abs(dy) >= Math.abs(dx)) {
          active.ignoredScroll = true;
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }

    active.moved = true;
    setIsDragging(true);
    updateOffset({
      x: active.origin.x + dx / active.scale,
      y: active.origin.y + dy / active.scale,
    });
    active.samples.push({
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    });
    active.samples = active.samples.filter(
      (sample) => event.timeStamp - sample.time <= velocityWindowMs
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;

    if (active.moved) {
      updateOffset({
        x: active.origin.x + (event.clientX - active.x) / active.scale,
        y: active.origin.y + (event.clientY - active.y) / active.scale,
      });
      active.samples.push({
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
      });
      active.samples = active.samples.filter(
        (sample) => event.timeStamp - sample.time <= velocityWindowMs
      );
      startInertia(active.samples, active.scale);
    } else if (
      !active.ignoredScroll &&
      (!hasHover || active.type !== "mouse")
    ) {
      setIsFlipped((current) => !current);
    }
    pointer.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.type === "touch" && active.moved) updateOffset(active.origin);
    pointer.current = null;
    setIsDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setIsFlipped((current) => !current);
  };

  return (
    <div
      className={`hero-flip-card ${className}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={showBack}
      data-flipped={showBack}
      data-dragging={isDragging}
      data-throwing={isThrowing}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onKeyDown={onKeyDown}
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
    >
      <div className="hero-flip-card-entrance">
        <div className="hero-flip-card-tilt">
          <div className="hero-flip-card-inner">
            <div className="hero-flip-card-face">{children}</div>
            <div className="hero-flip-card-face hero-flip-card-face--back">
              {back}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
