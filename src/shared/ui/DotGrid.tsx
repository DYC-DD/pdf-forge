import { useEffect, useRef, type CSSProperties } from "react";

import "./DotGrid.css";

interface Dot {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  velocityX: number;
  velocityY: number;
}

interface DotGridProps {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  speedTrigger?: number;
  shockRadius?: number;
  shockStrength?: number;
  maxSpeed?: number;
  resistance?: number;
  returnDuration?: number;
  className?: string;
  style?: CSSProperties;
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export default function DotGrid({
  dotSize = 5,
  gap = 15,
  baseColor = "#2F293A",
  activeColor = "#5227FF",
  proximity = 120,
  speedTrigger = 100,
  shockRadius = 250,
  shockStrength = 5,
  maxSpeed = 5000,
  resistance = 750,
  returnDuration = 1.5,
  className = "",
  style,
}: DotGridProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const zone = wrap?.parentElement?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!wrap || !canvas || !zone || !ctx) return;

    const base = hexToRgb(baseColor);
    const active = hexToRgb(activeColor);
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const cell = dotSize + gap;
    const spring = 70 / Math.max(returnDuration, 0.1);
    const damping = Math.max(5, resistance / 100);
    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerInside = false;
    let lastX = 0;
    let lastY = 0;
    let lastPointerTime = 0;
    let lastFrameTime = 0;
    let frameId = 0;

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      const radius = dotSize / 2;
      const proximitySquared = proximity * proximity;

      for (const dot of dots) {
        let color = baseColor;
        if (pointerInside) {
          const dx = dot.x - pointerX;
          const dy = dot.y - pointerY;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < proximitySquared) {
            const mix = 1 - Math.sqrt(distanceSquared) / proximity;
            const r = Math.round(base.r + (active.r - base.r) * mix);
            const g = Math.round(base.g + (active.g - base.g) * mix);
            const b = Math.round(base.b + (active.b - base.b) * mix);
            color = `rgb(${r} ${g} ${b})`;
          }
        }
        ctx.beginPath();
        ctx.arc(
          dot.x + dot.offsetX,
          dot.y + dot.offsetY,
          radius,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    function animate(now: number) {
      frameId = 0;
      const dt = Math.min((now - (lastFrameTime || now)) / 1000, 0.032);
      lastFrameTime = now;
      let moving = false;

      for (const dot of dots) {
        dot.velocityX += (-dot.offsetX * spring - dot.velocityX * damping) * dt;
        dot.velocityY += (-dot.offsetY * spring - dot.velocityY * damping) * dt;
        dot.offsetX += dot.velocityX * dt;
        dot.offsetY += dot.velocityY * dt;
        if (
          Math.abs(dot.offsetX) +
            Math.abs(dot.offsetY) +
            Math.abs(dot.velocityX) +
            Math.abs(dot.velocityY) <
          0.05
        ) {
          dot.offsetX = 0;
          dot.offsetY = 0;
          dot.velocityX = 0;
          dot.velocityY = 0;
        } else {
          moving = true;
        }
      }

      draw();
      if (moving) requestFrame();
      else lastFrameTime = 0;
    }

    function requestFrame() {
      if (!frameId) frameId = requestAnimationFrame(animate);
    }

    function buildGrid() {
      if (!wrap || !canvas || !ctx) return;
      const rect = wrap.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cols = Math.max(0, Math.floor((width + gap) / cell));
      const rows = Math.max(0, Math.floor((height + gap) / cell));
      const startX = (width - (cols * cell - gap)) / 2 + dotSize / 2;
      const startY = (height - (rows * cell - gap)) / 2 + dotSize / 2;
      dots = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          dots.push({
            x: startX + col * cell,
            y: startY + row * cell,
            offsetX: 0,
            offsetY: 0,
            velocityX: 0,
            velocityY: 0,
          });
        }
      }
      requestFrame();
    }

    function position(event: PointerEvent) {
      const rect = wrap!.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function onPointerMove(event: PointerEvent) {
      const point = position(event);
      const now = performance.now();
      const dt = lastPointerTime ? Math.max(now - lastPointerTime, 1) : 0;
      const dx = point.x - lastX;
      const dy = point.y - lastY;
      const speed = dt
        ? Math.min((Math.hypot(dx, dy) / dt) * 1000, maxSpeed)
        : 0;
      pointerX = point.x;
      pointerY = point.y;
      pointerInside = true;
      lastX = point.x;
      lastY = point.y;
      lastPointerTime = now;

      if (!reducedMotion && speed > speedTrigger) {
        for (const dot of dots) {
          const fromX = dot.x - point.x;
          const fromY = dot.y - point.y;
          const distance = Math.hypot(fromX, fromY);
          if (distance >= proximity || distance === 0) continue;
          const impulse =
            Math.min(speed / speedTrigger, 5) * 25 * (1 - distance / proximity);
          dot.velocityX += (fromX / distance) * impulse;
          dot.velocityY += (fromY / distance) * impulse;
        }
      }
      requestFrame();
    }

    function onPointerLeave() {
      pointerInside = false;
      lastPointerTime = 0;
      requestFrame();
    }

    function onPointerDown(event: PointerEvent) {
      if (reducedMotion) return;
      const point = position(event);
      for (const dot of dots) {
        const dx = dot.x - point.x;
        const dy = dot.y - point.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= shockRadius || distance === 0) continue;
        const impulse = shockStrength * 45 * (1 - distance / shockRadius);
        dot.velocityX += (dx / distance) * impulse;
        dot.velocityY += (dy / distance) * impulse;
      }
      requestFrame();
    }

    const observer = new ResizeObserver(buildGrid);
    observer.observe(wrap);
    zone.addEventListener("pointermove", onPointerMove, { passive: true });
    zone.addEventListener("pointerleave", onPointerLeave);
    zone.addEventListener("pointerdown", onPointerDown);
    buildGrid();

    return () => {
      observer.disconnect();
      zone.removeEventListener("pointermove", onPointerMove);
      zone.removeEventListener("pointerleave", onPointerLeave);
      zone.removeEventListener("pointerdown", onPointerDown);
      cancelAnimationFrame(frameId);
    };
  }, [
    dotSize,
    gap,
    baseColor,
    activeColor,
    proximity,
    speedTrigger,
    shockRadius,
    shockStrength,
    maxSpeed,
    resistance,
    returnDuration,
  ]);

  return (
    <div className={`dot-grid ${className}`} style={style} aria-hidden="true">
      <div ref={wrapRef} className="dot-grid__wrap">
        <canvas ref={canvasRef} className="dot-grid__canvas" />
      </div>
    </div>
  );
}
