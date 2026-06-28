import confetti from "canvas-confetti";

// Праздничный «взрыв» при успешном действии — два залпа с боков.
export function celebrate() {
  const colors = ["#8b5cff", "#5b7cfa", "#3b82f6", "#2ee6a6", "#ffffff"];
  const defaults = { spread: 70, ticks: 200, gravity: 0.9, scalar: 1, colors };
  confetti({ ...defaults, particleCount: 60, origin: { x: 0.1, y: 0.9 }, angle: 60 });
  confetti({ ...defaults, particleCount: 60, origin: { x: 0.9, y: 0.9 }, angle: 120 });
  confetti({ ...defaults, particleCount: 40, origin: { x: 0.5, y: 0.7 }, startVelocity: 35 });
}
