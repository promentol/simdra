import { initSync, createCanvas } from '../../dist/wasm/index.mjs';
import wasm from '../../dist/wasm/simdra.wasm';

initSync(wasm);

export default {
    async fetch(request, env, ctx) {
        const W = 1200, H = 630;
        const canvas = createCanvas(W, H);
        const g = canvas.getContext('2d');

        // Background: diagonal gradient
        const bg = g.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, '#0f172a');
        bg.addColorStop(0.5, '#1e293b');
        bg.addColorStop(1, '#0f172a');
        g.fillStyle = bg;
        g.fillRect(0, 0, W, H);

        // Soft radial spotlight from upper-left
        const spot = g.createRadialGradient(W * 0.25, H * 0.25, 0, W * 0.25, H * 0.25, 600);
        spot.addColorStop(0, 'rgba(96, 165, 250, 0.45)');
        spot.addColorStop(1, 'rgba(96, 165, 250, 0)');
        g.fillStyle = spot;
        g.fillRect(0, 0, W, H);

        // Concentric rotated squares (using transforms + stroke)
        g.save();
        g.translate(W * 0.78, H * 0.55);
        for (let i = 0; i < 12; i++) {
            g.rotate(Math.PI / 24);
            const t = i / 11;
            g.strokeStyle = `rgba(${56 + 200 * t}, ${189 - 60 * t}, ${248 - 80 * t}, ${0.85 - 0.6 * t})`;
            g.lineWidth = 2;
            const s = 60 + i * 18;
            g.strokeRect(-s / 2, -s / 2, s, s);
        }
        g.restore();

        // A row of filled circles with a conic gradient sweep
        for (let i = 0; i < 8; i++) {
            const cx = 140 + i * 70;
            const cy = H - 120;
            const r = 26;
            const cg = g.createConicGradient(i * 0.4, cx, cy);
            cg.addColorStop(0, '#f472b6');
            cg.addColorStop(0.5, '#a78bfa');
            cg.addColorStop(1, '#f472b6');
            g.fillStyle = cg;
            g.beginPath();
            g.arc(cx, cy, r, 0, Math.PI * 2);
            g.fill();
        }

        // Title text + tagline
        g.fillStyle = '#f8fafc';
        g.font = 'bold 96px sans-serif';
        g.textBaseline = 'top';
        g.fillText('simdra', 80, 90);

        g.fillStyle = 'rgba(248, 250, 252, 0.7)';
        g.font = '32px sans-serif';
        g.fillText('SIMD-accelerated 2D canvas, in a Worker', 80, 210);

        // Accent underline beneath the title
        const accent = g.createLinearGradient(80, 0, 480, 0);
        accent.addColorStop(0, '#22d3ee');
        accent.addColorStop(1, '#a78bfa');
        g.fillStyle = accent;
        g.fillRect(80, 195, 380, 4);

        const buffer = await canvas.toBytesAsync();

        // canvas.destroy();
        // g.dinit();

        return new Response(buffer, {
            headers: { 'Content-Type': 'image/png' },
        });
    },
};
