// GIF parsing and streaming compositing. Compressed frames are retained; RGBA
// canvases are allocated only while iterating composeGifFrames().
const DEFAULT_LIMITS = {
  maxWidth: 1024,
  maxHeight: 1024,
  maxFrames: 60,
  maxDurationMs: 15000,
  maxPixels: 1048576
};

function invalid(reason) {
  throw new Error('GIF 文件无效：' + reason);
}

class Reader {
  constructor(input) {
    if (input instanceof ArrayBuffer) input = new Uint8Array(input);
    if (!(input instanceof Uint8Array)) invalid('需要 ArrayBuffer 或 Uint8Array');
    this.bytes = input;
    this.position = 0;
  }

  take(count) {
    if (count < 0 || this.position + count > this.bytes.length) invalid('文件被截断');
    const result = this.bytes.subarray(this.position, this.position + count);
    this.position += count;
    return result;
  }

  byte() { return this.take(1)[0]; }

  word() {
    const bytes = this.take(2);
    return bytes[0] | (bytes[1] << 8);
  }

  blocks() {
    const chunks = [];
    let length = 0;
    for (;;) {
      const size = this.byte();
      if (!size) break;
      const chunk = this.take(size);
      chunks.push(chunk);
      length += size;
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

function text(bytes) {
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function emptyControl() {
  return { delay: 0, disposal: 0, transparentIndex: null };
}

function parseGif(input, limits) {
  const bounds = Object.assign({}, DEFAULT_LIMITS, limits || {});
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) invalid('处理限制无效');
  }
  const reader = new Reader(input);
  const signature = text(reader.take(6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') invalid('不是 GIF 图片');
  const width = reader.word();
  const height = reader.word();
  if (!width || !height) invalid('画布尺寸为零');
  if (width > bounds.maxWidth || height > bounds.maxHeight || width * height > bounds.maxPixels) {
    throw new Error('GIF 尺寸超过处理上限');
  }
  const packed = reader.byte();
  const backgroundIndex = reader.byte();
  reader.byte(); // Pixel aspect ratio does not change the logical pixel canvas.
  const globalPalette = packed & 128 ? reader.take(3 * (1 << ((packed & 7) + 1))) : null;
  if (globalPalette && backgroundIndex >= globalPalette.length / 3) invalid('背景颜色索引越界');
  const frames = [];
  let control = emptyControl();
  let loopCount = null;
  let totalDurationMs = 0;
  for (;;) {
    const marker = reader.byte();
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = reader.byte();
      if (label === 0xf9) {
        if (reader.byte() !== 4) invalid('图像控制扩展长度错误');
        const flags = reader.byte();
        const delay = reader.word();
        const index = reader.byte();
        if (reader.byte() !== 0) invalid('图像控制扩展缺少结束标记');
        const disposal = (flags >> 2) & 7;
        if (disposal > 3) invalid('不支持的帧处置方式');
        control = { delay, disposal, transparentIndex: flags & 1 ? index : null };
      } else if (label === 0xff) {
        if (reader.byte() !== 11) invalid('应用扩展长度错误');
        const application = text(reader.take(11));
        const payload = reader.blocks();
        if (application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') {
          if (payload.length !== 3 || payload[0] !== 1) invalid('循环扩展错误');
          loopCount = payload[1] | (payload[2] << 8);
        }
      } else if (label === 0x01) {
        // Plain-text drawing requires a font and cannot be faithfully rasterized.
        invalid('暂不支持 GIF 文本绘制扩展');
      } else {
        reader.blocks(); // Comments and unknown extensions are ignorable.
      }
      continue;
    }
    if (marker !== 0x2c) invalid('未知数据块');
    const left = reader.word();
    const top = reader.word();
    const frameWidth = reader.word();
    const frameHeight = reader.word();
    const frameFlags = reader.byte();
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) {
      invalid('帧尺寸或位置越界');
    }
    if (frameWidth * frameHeight > bounds.maxPixels) throw new Error('GIF 帧尺寸超过处理上限');
    const palette = frameFlags & 128
      ? reader.take(3 * (1 << ((frameFlags & 7) + 1)))
      : globalPalette;
    if (!palette) invalid('缺少颜色表');
    if (control.transparentIndex !== null && control.transparentIndex >= palette.length / 3) {
      invalid('透明颜色索引越界');
    }
    const minCodeSize = reader.byte();
    if (minCodeSize < 2 || minCodeSize > 8) invalid('LZW 初始位数错误');
    const compressed = reader.blocks();
    if (!compressed.length) invalid('缺少图像数据');
    frames.push(Object.assign({
      left, top, width: frameWidth, height: frameHeight,
      interlaced: Boolean(frameFlags & 64), palette, minCodeSize, compressed
    }, control));
    control = emptyControl();
    totalDurationMs += frames[frames.length - 1].delay * 10 || 100;
    if (frames.length > bounds.maxFrames) throw new Error('GIF 帧数超过处理上限');
    if (totalDurationMs > bounds.maxDurationMs) throw new Error('GIF 时长超过处理上限');
  }
  if (!frames.length) invalid('没有图像帧');
  return { width, height, backgroundIndex, globalPalette, loopCount,
    frameCount: frames.length, totalDurationMs, frames };
}

function decodeIndices(frame) {
  const output = new Uint8Array(frame.width * frame.height);
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  const clearCode = 1 << frame.minCodeSize;
  const endCode = clearCode + 1;
  for (let i = 0; i < clearCode; i++) suffix[i] = i;
  let nextCode = endCode + 1;
  let codeSize = frame.minCodeSize + 1;
  let bitOffset = 0;
  let previous = -1;
  let first = 0;
  let written = 0;
  let sawClear = false;
  const paletteSize = frame.palette.length / 3;
  function write(index) {
    if (index >= paletteSize) invalid('像素颜色索引越界');
    if (written >= output.length) invalid('LZW 像素数量过多');
    output[written++] = index;
  }
  for (;;) {
    if (bitOffset + codeSize > frame.compressed.length * 8) invalid('LZW 数据被截断');
    let code = 0;
    for (let bit = 0; bit < codeSize; bit++, bitOffset++) {
      code |= ((frame.compressed[bitOffset >> 3] >> (bitOffset & 7)) & 1) << bit;
    }
    if (code === clearCode) {
      nextCode = endCode + 1;
      codeSize = frame.minCodeSize + 1;
      previous = -1;
      sawClear = true;
      continue;
    }
    if (!sawClear) invalid('LZW 缺少初始清除码');
    if (code === endCode) {
      if (written !== output.length) invalid('LZW 像素数量不足');
      return output;
    }
    if (previous < 0) {
      if (code >= clearCode) invalid('LZW 首个颜色索引错误');
      write(code);
      first = code;
      previous = code;
      continue;
    }
    const originalCode = code;
    let count = 0;
    if (code === nextCode && nextCode < 4096) {
      stack[count++] = first;
      code = previous;
    } else if (code >= nextCode) {
      invalid('LZW 字典索引越界');
    }
    while (code >= clearCode) {
      if (code <= endCode || code >= nextCode || count >= stack.length) invalid('LZW 字典链错误');
      stack[count++] = suffix[code];
      const parent = prefix[code];
      if (parent >= code) invalid('LZW 字典循环');
      code = parent;
    }
    first = code;
    write(first);
    while (count) write(stack[--count]);
    if (nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = first;
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    previous = originalCode;
  }
}

function background(gif, frame) {
  // Transparent GIFs use a transparent logical background in common players,
  // including when the transparent palette index differs from backgroundIndex.
  if (!gif.globalPalette || frame.transparentIndex !== null) return [0, 0, 0, 0];
  const offset = gif.backgroundIndex * 3;
  return [gif.globalPalette[offset], gif.globalPalette[offset + 1], gif.globalPalette[offset + 2], 255];
}

function fillRect(canvas, canvasWidth, left, top, width, height, rgba) {
  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      canvas.set(rgba, (y * canvasWidth + x) * 4);
    }
  }
}

function* composeGifFrames(gif) {
  let canvas = new Uint8ClampedArray(gif.width * gif.height * 4);
  fillRect(canvas, gif.width, 0, 0, gif.width, gif.height, background(gif, gif.frames[0]));
  for (const frame of gif.frames) {
    const saved = frame.disposal === 3 ? canvas.slice() : null;
    const indices = decodeIndices(frame);
    let sourceOffset = 0;
    const passes = frame.interlaced ? [[0, 8], [4, 8], [2, 4], [1, 2]] : [[0, 1]];
    for (const pass of passes) {
      for (let y = pass[0]; y < frame.height; y += pass[1]) {
        for (let x = 0; x < frame.width; x++) {
          const index = indices[sourceOffset++];
          if (index === frame.transparentIndex) continue;
          const offset = ((frame.top + y) * gif.width + frame.left + x) * 4;
          canvas[offset] = frame.palette[index * 3];
          canvas[offset + 1] = frame.palette[index * 3 + 1];
          canvas[offset + 2] = frame.palette[index * 3 + 2];
          canvas[offset + 3] = 255;
        }
      }
    }
    yield { width: gif.width, height: gif.height, data: canvas.slice(), delay: frame.delay };
    if (frame.disposal === 2) {
      fillRect(canvas, gif.width, frame.left, frame.top, frame.width, frame.height, background(gif, frame));
    } else if (saved) {
      canvas = saved;
    }
  }
}

module.exports = { parseGif, composeGifFrames };
