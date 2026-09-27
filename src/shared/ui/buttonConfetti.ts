import confetti from "canvas-confetti";

export function fireButtonConfetti(button: HTMLButtonElement): void {
  const rect = button.getBoundingClientRect();

  void confetti({
    zIndex: 9999,
    origin: {
      x: (rect.left + rect.width / 2) / window.innerWidth,
      y: (rect.top + rect.height / 2) / window.innerHeight,
    },
    disableForReducedMotion: true,
  });
}
