import { useEffect, useRef, useState } from "react";

export type RevealState = "waiting" | "play" | "none";

export default function useScrollReveal<T extends HTMLElement>(
  initiallyVisible: boolean
) {
  const ref = useRef<T>(null);
  const [reveal, setReveal] = useState<RevealState>(() =>
    initiallyVisible ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "none"
      : "waiting"
  );

  useEffect(() => {
    if (reveal !== "waiting") return;
    if (typeof IntersectionObserver === "undefined") {
      setReveal("none");
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setReveal("play");
      },
      { rootMargin: "0px 0px 80px 0px" }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [reveal]);

  return { ref, reveal, setReveal };
}
