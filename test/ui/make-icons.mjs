/* Generates public/icons/*.png (simple chart-line icon). Run: node test/ui/make-icons.mjs */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/icons");
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
function png(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const k = size / 512, safe = maskable ? 0.72 : 1, off = (512 - 512 * safe) / 2;
  const P = [[96, 352], [196, 252], [260, 308], [400, 160]].map(([x, y]) => [(off + x * safe) * k, (off + y * safe) * k]);
  const w = 20 * safe * k * 2 / 2, dot = [P[3], 38 * safe * k];
  const dseg = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  const radius = 96 * k;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0, bg = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const fx = x + (sx + 0.5) / 3, fy = y + (sy + 0.5) / 3;
      const inRound = maskable || (() => { const cx = Math.min(Math.max(fx, radius), size - radius), cy = Math.min(Math.max(fy, radius), size - radius); return Math.hypot(fx - cx, fy - cy) <= radius; })();
      if (inRound) bg++;
      const line = Math.min(dseg(fx, fy, P[0], P[1]), dseg(fx, fy, P[1], P[2]), dseg(fx, fy, P[2], P[3])) <= w || Math.hypot(fx - dot[0][0], fy - dot[0][1]) <= dot[1];
      if (line) cover++;
    }
    const i = (y * size + x) * 4, a = bg / 9, f = cover / 9;
    px[i] = Math.round(26 * (1 - f) + 255 * f); px[i + 1] = Math.round(79 * (1 - f) + 255 * f); px[i + 2] = Math.round(208 * (1 - f) + 255 * f); px[i + 3] = Math.round(255 * Math.max(a, f));
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(out, "icon-192.png"), png(192, false));
fs.writeFileSync(path.join(out, "icon-512.png"), png(512, false));
fs.writeFileSync(path.join(out, "icon-maskable-512.png"), png(512, true));
console.log("icons written");
