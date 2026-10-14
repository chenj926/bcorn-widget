// 生成图标：
//   assets/trayTemplate(@2x).png  菜单栏模板图标（黑色 + 透明，macOS 自动适配深浅色）
//   assets/icon.icns              应用图标（打包 .app 用）
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));

const rr = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const box = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// ---- 菜单栏图标：18×18 pt 的日历线稿 ----

function trayColor(x, y) {
  const outer = rr(x, y, 2, 3, 16, 16, 2.5);
  const inner = rr(x, y, 3.5, 7, 14.5, 14.5, 1);
  const tabs = box(x, y, 5.2, 1.5, 6.8, 4.5) || box(x, y, 11.2, 1.5, 12.8, 4.5);
  const dots = [[6, 9.4], [9, 9.4], [12, 9.4], [6, 12.2], [9, 12.2]].some(([dx, dy]) => box(x, y, dx - 0.8, dy - 0.8, dx + 0.8, dy + 0.8));
  return (outer && !inner) || tabs || dots ? [0, 0, 0] : null;
}

// ---- 应用图标：1024 单位画布，macOS 图标网格（824 的圆角方块，四周留 100） ----

const NAVY_TOP = hex('#2d4f8e');
const NAVY_BOTTOM = hex('#1a2f57');
const WHITE = hex('#ffffff');
const CORAL = hex('#e5484d');
const CELL = hex('#cbd5e8');
const TODAY = hex('#1e3765');

function appColor(x, y) {
  if (!rr(x, y, 100, 100, 924, 924, 185)) return null;
  let color = mix(NAVY_TOP, NAVY_BOTTOM, (y - 100) / 824);
  const card = rr(x, y, 252, 300, 772, 772, 72);
  if (card) color = y < 440 ? CORAL : WHITE;
  if (rr(x, y, 366, 240, 418, 360, 26) || rr(x, y, 606, 240, 658, 360, 26)) color = WHITE;
  for (const [i, cx] of [372, 512, 652].entries()) {
    for (const [j, cy] of [540, 666].entries()) {
      if (rr(x, y, cx - 40, cy - 40, cx + 40, cy + 40, 18)) color = i === 1 && j === 0 ? TODAY : CELL;
    }
  }
  return color;
}

// ---- 光栅化 + PNG ----

function render(sizePx, units, colorAt, ss = 4) {
  const rgba = Buffer.alloc(sizePx * sizePx * 4);
  const k = units / sizePx;
  for (let py = 0; py < sizePx; py++) {
    for (let px = 0; px < sizePx; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colorAt((px + (sx + 0.5) / ss) * k, (py + (sy + 0.5) / ss) * k);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (py * sizePx + px) * 4;
      if (a) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round((255 * a) / (ss * ss));
    }
  }
  return png(sizePx, sizePx, rgba);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(assets, { recursive: true });
writeFileSync(`${assets}trayTemplate.png`, render(18, 18, trayColor));
writeFileSync(`${assets}trayTemplate@2x.png`, render(36, 18, trayColor));

const iconset = `${assets}icon.iconset/`;
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  writeFileSync(`${iconset}icon_${size}x${size}.png`, render(size, 1024, appColor, size < 128 ? 6 : 3));
  writeFileSync(`${iconset}icon_${size}x${size}@2x.png`, render(size * 2, 1024, appColor, size < 128 ? 6 : 3));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', `${assets}icon.icns`]);
writeFileSync(`${assets}icon.png`, render(512, 1024, appColor, 3)); // 预览用
rmSync(iconset, { recursive: true, force: true });
console.log('assets/trayTemplate.png, assets/trayTemplate@2x.png, assets/icon.icns, assets/icon.png');
