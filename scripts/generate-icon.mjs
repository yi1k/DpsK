// 生成应用图标：build/icon.png（512x512）与 build/icon.ico（多尺寸 BMP 型 ICO）
// 纯 Node 实现，无第三方依赖。用法：npm run icon
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, '..', 'build');
const PNG_SIZE = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 像素绘制 ----------
function inRoundedRect(x, y, rx, ry, w, h, r) {
  const cx = Math.max(rx + r, Math.min(x, rx + w - r));
  const cy = Math.max(ry + r, Math.min(y, ry + h - r));
  return Math.hypot(x - cx, y - cy) <= r;
}

function pixel(x, y, size) {
  const pad = size * 0.06;
  const radius = size * 0.22;
  if (!inRoundedRect(x, y, pad, pad, size - 2 * pad, size - 2 * pad, radius)) {
    return [0, 0, 0, 0];
  }
  // 对角线渐变：靛蓝 -> 深蓝黑
  const t = (x + y) / (2 * size);
  const r = Math.round(0x4f + (0x0f - 0x4f) * t);
  const g = Math.round(0x46 + (0x17 - 0x46) * t);
  const b = Math.round(0xe5 + (0x2a - 0xe5) * t);

  const cx = size / 2;
  const cy = size / 2;
  const d = Math.hypot(x - cx, y - cy);
  const ringOuter = size * 0.3;
  const ringInner = size * 0.22;
  const dotR = size * 0.09;

  if (d <= ringOuter && d >= ringInner) return [255, 255, 255, 255]; // 白色圆环
  if (d <= dotR) return [255, 255, 255, 255]; // 中心圆点
  return [r, g, b, 255];
}

// ---------- ICO 编码（BMP 型，兼容 electron-builder）----------
function makeIcoBmp(size) {
  // BITMAPINFOHEADER
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);      // biSize
  info.writeInt32LE(size, 4);     // biWidth
  info.writeInt32LE(size * 2, 8); // biHeight（XOR + AND 掩码）
  info.writeUInt16LE(1, 12);      // biPlanes
  info.writeUInt16LE(32, 14);     // biBitCount
  info.writeUInt32LE(0, 16);      // biCompression: BI_RGB

  // XOR 数据：自下而上（BMP 顺序），BGRA，非预乘 alpha
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, srcY, size);
      const o = (y * size + x) * 4;
      xor[o] = b; xor[o + 1] = g; xor[o + 2] = r; xor[o + 3] = a;
    }
  }

  // AND 掩码：全部透明位为 0（32bpp 下可省略实际掩码，但保留正确的行宽）
  const andMask = Buffer.alloc(size * Math.ceil(size / 8), 0);

  return Buffer.concat([info, xor, andMask]);
}

function makeIco(sizes) {
  const images = sizes.map((s) => makeIcoBmp(s));
  const header = Buffer.alloc(6);
  header[2] = 1; // type: icon（字节 0-1 保留，字节 2-3 类型，字节 4-5 数量）
  header.writeUInt16LE(images.length, 4); // 图像数量
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (let i = 0; i < images.length; i++) {
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 宽（0 表示 256）
    entry[1] = size >= 256 ? 0 : size; // 高
    entry[2] = 0; // 调色板大小
    entry[3] = 0; // 保留
    entry.writeUInt16LE(1, 4);          // 色彩平面
    entry.writeUInt16LE(32, 6);         // 位深
    entry.writeUInt32LE(images[i].length, 8); // 数据长度
    entry.writeUInt32LE(offset, 12);    // 数据偏移
    entries.push(entry);
    offset += images[i].length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

// ---------- 输出 ----------
fs.mkdirSync(buildDir, { recursive: true });

const png = makePng(PNG_SIZE);
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);

const ico = makeIco(ICO_SIZES);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

console.log(`OK: build/icon.png (${png.length} bytes, ${PNG_SIZE}x${PNG_SIZE})`);
console.log(`OK: build/icon.ico (${ico.length} bytes, sizes ${ICO_SIZES.join('/')})`);
