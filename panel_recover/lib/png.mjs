// Minimal PNG reader for the panel's screenshots: 8-bit RGB or RGBA, not interlaced (what /screenshot returns).
// decodePng(buffer, { width, height }) -> { width, height, rgb(x, y) -> [r, g, b], region(x0, y0, x1, y1) -> RGB bytes,
// row by row, of the rectangle [x0, x1) x [y0, y1) }. The data comes from the network,
// so the size is checked before anything is inflated and inflating stops at the size the header promises.
// Throws on anything else (another size when one is expected, a bad chunk, filter or colour type, too little data).
import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 16 * 1024 * 1024;

export function decodePng(buf, { width: wantWidth, height: wantHeight } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    if (i + 12 > buf.length) throw new Error('PNG chunk header runs past the end');
    const len = buf.readUInt32BE(i);
    if (i + 12 + len > buf.length) throw new Error('PNG chunk runs past the end');
    const type = buf.toString('latin1', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      if (len < 13) throw new Error('PNG IHDR is too short');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = data.subarray(8, 13);
      if (wantWidth !== undefined && (width !== wantWidth || height !== wantHeight)) throw new Error(`PNG is ${width}x${height}, expected ${wantWidth}x${wantHeight}`);
      if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error(`PNG size ${width}x${height} is out of range`);
      if (interlace !== 0) throw new Error('interlaced PNG is not supported');
      if (depth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`PNG colour type ${colorType}/${depth}-bit is not supported`);
      bpp = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      if (!bpp) throw new Error('PNG image data before IHDR');
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    i += 12 + len;
  }
  if (!bpp || !idat.length) throw new Error('PNG without IHDR or image data');
  const stride = width * bpp;
  const size = (stride + 1) * height;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: size });
  } catch (e) {
    throw new Error(`PNG image data is not a ${width}x${height} image (${e.code || e.message})`);
  }
  if (raw.length !== size) throw new Error('PNG image data is truncated');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`PNG row filter ${filter} is not valid`);
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = (raw[src + x] + pred) & 0xff;
    }
  }
  return {
    width,
    height,
    rgb(x, y) {
      const i = y * stride + x * bpp;
      return [px[i], px[i + 1], px[i + 2]];
    },
    region(x0, y0, x1, y1) {
      const out = Buffer.alloc((x1 - x0) * (y1 - y0) * 3);
      let o = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * stride + x * bpp;
          out[o++] = px[i]; out[o++] = px[i + 1]; out[o++] = px[i + 2];
        }
      }
      return out;
    },
  };
}
