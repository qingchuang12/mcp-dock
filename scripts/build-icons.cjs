// 从 assets/icon.png 生成 build/icon.ico（多尺寸）与 build/icon.png（Linux 运行时用）。
// 纯 Node 实现，不依赖任何 npm 包（electron-icon-builder 因 phantomjs 下载失败无法安装）。
// 生成 ICO 时每帧内嵌 PNG（Windows 自 Vista 起支持 PNG-in-ICO），按双线性缩放得到各尺寸。
//
// 背景：src/main/index.ts 在运行时读取 build/icon.{ico,icns,png}，但 build/ 目录之前不存在，
// 导致窗口/任务栏图标找不到。本脚本在 build / package 前自动生成这三份（icns 仅 mac 需要，
// 这里跳过，mac 打包时可补；win/linux 用 ico/png 已足够）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = process.cwd();
const srcPath = path.join(root, 'assets', 'icon.png');
const outDir = path.join(root, 'build');

if (!fs.existsSync(srcPath)) {
  console.error('[build-icons] 找不到 assets/icon.png');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// ---- 解析源 PNG (最小 PNG 解码：IHDR + IDAT -> 解滤镜 -> RGBA) ----
function decodePNG(buf) {
  let p = 8;
  let w, h, bitDepth, colorType;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8-bit PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    for (let x = 0; x < stride; x++) {
      const rawVal = raw[pos++];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= channels && y > 0) ? out[(y - 1) * stride + x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = rawVal; break;
        case 1: val = rawVal + a; break;
        case 2: val = rawVal + b; break;
        case 3: val = rawVal + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          val = rawVal + pr; break;
        }
        default: val = rawVal;
      }
      out[y * stride + x] = val & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

// 双线性缩放为 size x size 的 RGBA
function resize(src, size) {
  const { w, h, channels, data } = src;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = (y + 0.5) / size * h - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5) / size * w - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const cSrc = c < channels ? c : 3; // 缺 alpha 时取 255
        const v00 = channels === 1 ? (c === 3 ? 255 : data[y0 * w + x0]) : data[(y0 * w + x0) * channels + cSrc];
        const v01 = channels === 1 ? (c === 3 ? 255 : data[y0 * w + x1]) : data[(y0 * w + x1) * channels + cSrc];
        const v10 = channels === 1 ? (c === 3 ? 255 : data[y1 * w + x0]) : data[(y1 * w + x0) * channels + cSrc];
        const v11 = channels === 1 ? (c === 3 ? 255 : data[y1 * w + x1]) : data[(y1 * w + x1) * channels + cSrc];
        const top = v00 * (1 - fx) + v01 * fx;
        const bot = v10 * (1 - fx) + v11 * fx;
        out[(y * size + x) * 4 + c] = Math.round(top * (1 - fy) + bot * fy) & 0xff;
      }
    }
  }
  return out;
}

// 编码 RGBA -> PNG（无滤镜）
function encodePNG(rgba, size) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const src = decodePNG(fs.readFileSync(srcPath));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = sizes.map(s => encodePNG(resize(src, s), s));

// 组装 ICO（每帧 PNG 内嵌）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = 6 + 16 * frames.length;
const entries = [];
const body = [];
for (const fb of frames) {
  const e = Buffer.alloc(16);
  e[0] = 0; e[1] = 0; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(fb.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  body.push(fb);
  offset += fb.length;
}
const ico = Buffer.concat([header, ...entries, ...body]);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

// Linux 运行时用 PNG
fs.copyFileSync(srcPath, path.join(outDir, 'icon.png'));

// ---- 组装 ICNS（macOS 运行时窗口图标，src/main/index.ts 的 getIconPath() 读取）----
// 格式：文件头 'icns' + 文件总长度(4 字节大端)，其后若干条目，每条目为
// 「4 字节 OSType + 4 字节条目总长度(含自身 8 字节) + PNG 数据」。
// 全部用 PNG 编码（macOS 10.7+ 支持），源图 512，故最大到 ic09。
// 类型映射：icp4=16 icp5=32 icp6=64 ic07=128 ic08=256 ic09=512
const icnsTypes = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
];
const icnsEntries = icnsTypes.map(([type, size]) => {
    const png = encodePNG(resize(src, size), size);
    const entryHeader = Buffer.alloc(8);
    Buffer.from(type, 'ascii').copy(entryHeader, 0);
    entryHeader.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([entryHeader, png]);
});
const icnsBody = Buffer.concat(icnsEntries);
const icnsHeader = Buffer.alloc(8);
Buffer.from('icns', 'ascii').copy(icnsHeader, 0);
icnsHeader.writeUInt32BE(8 + icnsBody.length, 4);
fs.writeFileSync(path.join(outDir, 'icon.icns'), Buffer.concat([icnsHeader, icnsBody]));

console.log(`[build-icons] 生成 build/icon.ico (${sizes.length} 帧) + build/icon.icns (${icnsTypes.length} 帧) + build/icon.png`);
