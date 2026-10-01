'use strict';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

// Each frame has its own palette. Reserve index zero for transparency, even
// when a frame is opaque, so disposal-to-background clears previous subjects.
function quantize(rgba) {
  const exact = new Map();
  let tooMany = false;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const colour = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (!exact.has(colour)) {
      exact.set(colour, exact.size + 1);
      if (exact.size > 255) { tooMany = true; break; }
    }
  }
  const palette = [[0, 0, 0]];
  const indices = new Uint8Array(rgba.length / 4);
  if (!tooMany) {
    for (const colour of exact.keys()) palette.push([colour >>> 16, (colour >>> 8) & 255, colour & 255]);
    for (let i = 0; i < indices.length; i++) {
      const offset = i * 4;
      if (rgba[offset + 3] >= 128) indices[i] = exact.get((rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2]);
    }
    return { palette, indices };
  }

  // Bound histogram memory independently of the number of distinct RGB values.
  const counts = new Uint32Array(32768);
  const sums = [new Float64Array(32768), new Float64Array(32768), new Float64Array(32768)];
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    counts[key]++;
    for (let channel = 0; channel < 3; channel++) sums[channel][key] += rgba[i + channel];
  }
  const colours = [];
  for (let key = 0; key < counts.length; key++) {
    if (counts[key]) colours.push({ key, count: counts[key], rgb: sums.map(sum => sum[key] / counts[key]) });
  }
  function box(items) {
    const min = [255, 255, 255];
    const max = [0, 0, 0];
    let weight = 0;
    for (const item of items) {
      weight += item.count;
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], item.rgb[c]);
        max[c] = Math.max(max[c], item.rgb[c]);
      }
    }
    const ranges = max.map((value, c) => value - min[c]);
    const channel = ranges.indexOf(Math.max(...ranges));
    return { items, weight, channel, score: items.length > 1 ? ranges[channel] * Math.sqrt(weight) : -1 };
  }
  const boxes = [box(colours)];
  while (boxes.length < 255) {
    let selected = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[selected].score) selected = i;
    const current = boxes[selected];
    if (current.score < 0) break;
    current.items.sort((a, b) => a.rgb[current.channel] - b.rgb[current.channel] || a.key - b.key);
    let accumulated = 0;
    let split = 0;
    while (split < current.items.length - 1 && accumulated < current.weight / 2) accumulated += current.items[split++].count;
    boxes[selected] = box(current.items.slice(0, split));
    boxes.push(box(current.items.slice(split)));
  }
  for (const current of boxes) {
    const rgb = [0, 0, 0];
    for (const item of current.items) for (let c = 0; c < 3; c++) rgb[c] += item.rgb[c] * item.count;
    palette.push(rgb.map(value => Math.round(value / current.weight)));
  }
  const lookup = new Uint8Array(32768);
  for (const item of colours) {
    let nearest = 1;
    let distance = Infinity;
    for (let p = 1; p < palette.length; p++) {
      let candidate = 0;
      for (let c = 0; c < 3; c++) candidate += (item.rgb[c] - palette[p][c]) ** 2;
      if (candidate < distance) { distance = candidate; nearest = p; }
    }
    lookup[item.key] = nearest;
  }
  for (let i = 0; i < indices.length; i++) {
    const offset = i * 4;
    if (rgba[offset + 3] >= 128) indices[i] = lookup[((rgba[offset] >> 3) << 10) | ((rgba[offset + 1] >> 3) << 5) | (rgba[offset + 2] >> 3)];
  }
  return { palette, indices };
}

class GifEncoder {
  constructor(width, height, options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('GIF options must be an object');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535 || width * height > 4194304) {
      throw new RangeError('GIF dimensions must be positive integers, at most 65535 per side and 4194304 pixels');
    }
    const { loopCount = null, maxBytes = DEFAULT_MAX_BYTES } = options;
    if (loopCount !== null && (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 65535)) throw new RangeError('Invalid GIF loop count');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid GIF byte limit');
    this.width = width;
    this.height = height;
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.byteLength = 0;
    this.frameCount = 0;
    this.finished = false;
    this.failed = false;
    const header = [71, 73, 70, 56, 57, 97, width & 255, width >>> 8, height & 255, height >>> 8, 0x80, 0, 0, 0, 0, 0, 0, 0, 0];
    // A two-entry global palette defines the transparent disposal background.
    if (loopCount !== null) header.push(0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, loopCount & 255, loopCount >>> 8, 0);
    this._append(new Uint8Array(header));
  }

  _append(chunk) {
    // Always reserve the final trailer byte, and release partial output on error.
    if (this.byteLength + chunk.length + 1 > this.maxBytes) {
      this.failed = true;
      this.chunks = [];
      throw new RangeError('GIF output exceeds maxBytes');
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
  }

  addFrame(rgba, delay = 10) {
    if (this.finished || this.failed) throw new Error('GIF encoder is closed');
    if (!(rgba instanceof Uint8ClampedArray) && !(rgba instanceof Uint8Array)) throw new TypeError('GIF frame must be an RGBA typed array');
    if (rgba.length !== this.width * this.height * 4) throw new RangeError('GIF frame length does not match dimensions');
    if (!Number.isInteger(delay) || delay < 0 || delay > 65535) throw new RangeError('GIF delay must be 0–65535 centiseconds');
    const { palette, indices } = quantize(rgba);
    let bits = 1;
    while ((1 << bits) < palette.length) bits++;
    const tableSize = 1 << bits;
    const descriptor = [0x21, 0xf9, 4, 9, delay & 255, delay >>> 8, 0, 0, 0x2c, 0, 0, 0, 0,
      this.width & 255, this.width >>> 8, this.height & 255, this.height >>> 8, 0x80 | (bits - 1)];
    for (let i = 0; i < tableSize; i++) descriptor.push(...(palette[i] || [0, 0, 0]));
    const minCodeSize = Math.max(2, bits);
    descriptor.push(minCodeSize);
    this._append(new Uint8Array(descriptor));
    this._writeLzw(indices, minCodeSize);
    this.frameCount++;
    return this;
  }

  _writeLzw(indices, minCodeSize) {
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let dictionary = new Map();
    let nextCode = end + 1;
    let codeSize = minCodeSize + 1;
    let accumulator = 0;
    let bitCount = 0;
    let block = [];
    const byte = value => {
      block.push(value);
      if (block.length === 255) {
        this._append(new Uint8Array([255, ...block]));
        block = [];
      }
    };
    const emit = code => {
      accumulator |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        byte(accumulator & 255);
        accumulator >>>= 8;
        bitCount -= 8;
      }
      // The decoder creates each dictionary entry one emitted code later.
      // Increase width AFTER this code, including the final pixel code.
      if (code !== clear && nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
    };
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const suffix = indices[i];
      const key = prefix * 256 + suffix;
      const existing = dictionary.get(key);
      if (existing !== undefined) { prefix = existing; continue; }
      emit(prefix);
      if (nextCode < 4096) dictionary.set(key, nextCode++);
      else {
        emit(clear);
        dictionary = new Map();
        nextCode = end + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = suffix;
    }
    emit(prefix);
    emit(end);
    if (bitCount) byte(accumulator & 255);
    if (block.length) this._append(new Uint8Array([block.length, ...block]));
    this._append(new Uint8Array([0]));
  }

  finish() {
    if (this.finished || this.failed) throw new Error('GIF encoder is closed');
    if (!this.frameCount) throw new Error('GIF requires at least one frame');
    const output = new Uint8Array(this.byteLength + 1);
    let offset = 0;
    for (const chunk of this.chunks) { output.set(chunk, offset); offset += chunk.length; }
    output[offset] = 0x3b;
    this.finished = true;
    this.chunks = [];
    return output;
  }
}

module.exports = { GifEncoder };
