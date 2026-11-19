import { useEffect, useRef } from "react";

/**
 * Animated "circuit" background for the login page: a grid of nodes joined by
 * faint lines, with light pulses travelling along the lines. It follows the
 * light/dark theme and stops moving for users who prefer reduced motion.
 */
export default function AuthBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let nodes: { x: number; y: number; vx: number; vy: number }[] = [];
    let pulses: { a: number; b: number; t: number; speed: number }[] = [];
    let raf = 0;

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(90, Math.max(30, (width * height) / 16000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
      }));
      pulses = [];
    };

    const linkDistance = () => Math.min(170, Math.max(110, width / 7));

    const frame = () => {
      const dark = document.documentElement.classList.contains("dark");
      const line = dark ? "96, 165, 250" : "79, 70, 229";
      const glow = dark ? "125, 211, 252" : "99, 102, 241";

      ctx.clearRect(0, 0, width, height);

      // Move nodes; bounce them softly off the edges.
      if (!reduce) {
        for (const n of nodes) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < 0 || n.x > width) n.vx *= -1;
          if (n.y < 0 || n.y > height) n.vy *= -1;
        }
      }

      const maxD = linkDistance();
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const d = Math.hypot(dx, dy);
          if (d < maxD) {
            ctx.strokeStyle = `rgba(${line}, ${(1 - d / maxD) * (dark ? 0.35 : 0.22)})`;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      // Start new pulses on random links; they travel from node a to node b.
      if (!reduce && pulses.length < 14 && Math.random() < 0.08) {
        const a = Math.floor(Math.random() * nodes.length);
        const near = nodes
          .map((n, i) => ({ i, d: Math.hypot(n.x - nodes[a].x, n.y - nodes[a].y) }))
          .filter((x) => x.i !== a && x.d < maxD);
        if (near.length) {
          const b = near[Math.floor(Math.random() * near.length)].i;
          pulses.push({ a, b, t: 0, speed: 0.008 + Math.random() * 0.012 });
        }
      }

      pulses = pulses.filter((p) => p.t <= 1);
      for (const p of pulses) {
        p.t += p.speed;
        const A = nodes[p.a];
        const B = nodes[p.b];
        const x = A.x + (B.x - A.x) * p.t;
        const y = A.y + (B.y - A.y) * p.t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
        g.addColorStop(0, `rgba(${glow}, ${dark ? 0.9 : 0.6})`);
        g.addColorStop(1, `rgba(${glow}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fill();
      }

      // Nodes, drawn last so they sit on top of the lines.
      ctx.fillStyle = `rgba(${glow}, ${dark ? 0.7 : 0.45})`;
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduce) raf = requestAnimationFrame(frame);
    };

    build();
    frame();
    const onResize = () => {
      cancelAnimationFrame(raf);
      build();
      frame();
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-slate-50 to-sky-50 dark:from-[#0a101c] dark:via-[#0b1224] dark:to-[#0c1a2e]" />
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
      <div className="absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-indigo-400/20 blur-3xl dark:bg-indigo-500/20" />
      <div className="absolute -bottom-48 -right-40 h-[30rem] w-[30rem] rounded-full bg-sky-400/20 blur-3xl dark:bg-cyan-400/15" />
    </div>
  );
}
