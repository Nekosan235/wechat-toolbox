'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { GifEncoder } = require('../utils/gif-encoder');

function rgba(...colours) { return new Uint8ClampedArray(colours.flat()); }

// Read GIF structure without implementing an LZW decoder: pixel round-trips
// below use the independent, installed FFmpeg decoder instead.
function inspect(bytes) {
  assert.equal(Buffer.from(bytes.subarray(0, 6)).toString(), 'GIF89a');
  const word = offset => bytes[offset] | (bytes[offset + 1] << 8);
  const result = { width: word(6), height: word(8), loop: null, frames: [] };
  let offset = 13 + ((bytes[10] & 128) ? 3 * (2 << (bytes[10] & 7)) : 0);
  let gce = null;
  function subBlocks() {
    const output = [];
    while (bytes[offset]) {
      const size = bytes[offset++];
      output.push(...bytes.subarray(offset, offset + size));
      offset += size;
    }
    offset++;
    return output;
  }
  while (bytes[offset] !== 0x3b) {
    assert.ok(offset < bytes.length, 'GIF trailer missing');
    const introducer = bytes[offset++];
    if (introducer === 0x21) {
      const label = bytes[offset++];
      const payload = subBlocks();
      if (label === 0xf9) gce = { disposal: (payload[0] >> 2) & 7, transparent: !!(payload[0] & 1), delay: payload[1] | (payload[2] << 8), transparentIndex: payload[3] };
      if (label === 0xff && Buffer.from(payload.slice(0, 11)).toString() === 'NETSCAPE2.0') result.loop = payload[12] | (payload[13] << 8);
    } else {
      assert.equal(introducer, 0x2c);
      const frame = { ...gce, x: word(offset), y: word(offset + 2), width: word(offset + 4), height: word(offset + 6) };
      const packed = bytes[offset + 8];
      offset += 9;
      assert.ok(packed & 128, 'each frame needs a local palette');
      const paletteBytes = 3 * (2 << (packed & 7));
      frame.palette = bytes.slice(offset, offset + paletteBytes);
      offset += paletteBytes;
      frame.minCodeSize = bytes[offset++];
      frame.compressed = subBlocks();
      result.frames.push(frame);
    }
  }
  assert.equal(offset, bytes.length - 1);
  return result;
}

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
function decode(bytes) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'gif', '-i', 'pipe:0', '-vsync', '0', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {
    input: bytes, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr && result.stderr.toString());
  assert.ok(!result.stderr.length, result.stderr.toString());
  return result.stdout;
}

test('GIF89a dimensions, local palettes, transparent disposal, delays and loop count', () => {
  const encoder = new GifEncoder(2, 1, { loopCount: 7 });
  encoder.addFrame(rgba([200, 10, 20, 255], [0, 0, 0, 0]), 3);
  encoder.addFrame(rgba([0, 0, 0, 0], [20, 190, 30, 255]), 65535);
  const gif = inspect(encoder.finish());
  assert.equal(gif.width, 2);
  assert.equal(gif.height, 1);
  assert.equal(gif.loop, 7);
  assert.equal(gif.frames.length, 2);
  for (const frame of gif.frames) {
    assert.equal(frame.disposal, 2);
    assert.equal(frame.transparent, true);
    assert.equal(frame.transparentIndex, 0);
    assert.deepEqual([frame.x, frame.y, frame.width, frame.height], [0, 0, 2, 1]);
  }
  assert.equal(gif.frames[0].delay, 3);
  assert.equal(gif.frames[1].delay, 65535);
  assert.deepEqual([...gif.frames[0].palette.slice(3, 6)], [200, 10, 20]);
  assert.deepEqual([...gif.frames[1].palette.slice(3, 6)], [20, 190, 30]);
});

test('null loop omits extension, zero loop preserves infinite repeat, zero delay is preserved', () => {
  for (const loopCount of [null, 0, 65535]) {
    const encoder = new GifEncoder(1, 1, { loopCount });
    encoder.addFrame(rgba([0, 0, 0, 0]), 0);
    const gif = inspect(encoder.finish());
    assert.equal(gif.loop, loopCount);
    assert.equal(gif.frames[0].delay, 0);
    assert.equal(gif.frames[0].minCodeSize, 2);
  }
});

test('source remains unchanged and frames are not retained', () => {
  const source = rgba([12, 34, 56, 255], [67, 89, 10, 127]);
  const before = source.slice();
  const encoder = new GifEncoder(2, 1);
  encoder.addFrame(source);
  assert.deepEqual(source, before);
  assert.ok(!Object.values(encoder).includes(source));
  source.fill(0);
  const gif = inspect(encoder.finish());
  assert.deepEqual([...gif.frames[0].palette.slice(3, 6)], [12, 34, 56]);
});

test('dimension, options, frame input and delay validation', () => {
  for (const [width, height] of [[0, 1], [1, -1], [1.5, 1], [NaN, 1], [65536, 1], [2049, 2048]]) {
    assert.throws(() => new GifEncoder(width, height), RangeError);
  }
  assert.throws(() => new GifEncoder(1, 1, null), TypeError);
  for (const options of [{ loopCount: -1 }, { loopCount: 65536 }, { loopCount: 1.5 }, { maxBytes: 0 }, { maxBytes: Infinity }]) {
    assert.throws(() => new GifEncoder(1, 1, options), RangeError);
  }
  const encoder = new GifEncoder(1, 1);
  assert.throws(() => encoder.finish(), /at least one frame/);
  assert.throws(() => encoder.addFrame([0, 0, 0, 0]), TypeError);
  assert.throws(() => encoder.addFrame(new Uint8ClampedArray(8)), RangeError);
  for (const delay of [-1, 65536, 0.5, NaN]) assert.throws(() => encoder.addFrame(rgba([0, 0, 0, 0]), delay), RangeError);
  encoder.addFrame(rgba([0, 0, 0, 0]));
  encoder.finish();
  assert.throws(() => encoder.finish(), /closed/);
  assert.throws(() => encoder.addFrame(rgba([0, 0, 0, 0])), /closed/);
});

test('maxBytes includes trailer and overflow closes encoder and releases partial output', () => {
  const source = rgba([1, 2, 3, 255]);
  const first = new GifEncoder(1, 1);
  first.addFrame(source);
  const output = first.finish();
  const exact = new GifEncoder(1, 1, { maxBytes: output.length });
  exact.addFrame(source);
  assert.deepEqual(exact.finish(), output);
  const limited = new GifEncoder(1, 1, { maxBytes: output.length - 1 });
  assert.throws(() => limited.addFrame(source), /maxBytes/);
  assert.equal(limited.chunks.length, 0);
  assert.throws(() => limited.finish(), /closed/);
  assert.throws(() => new GifEncoder(1, 1, { maxBytes: 19 }), /maxBytes/);
});

test('independent FFmpeg alpha threshold and disposal avoid transparent trails', { skip: !ffmpegAvailable }, () => {
  const encoder = new GifEncoder(3, 1, { loopCount: 0 });
  encoder.addFrame(rgba([255, 0, 0, 128], [0, 0, 255, 127], [10, 20, 30, 255]), 4);
  encoder.addFrame(rgba([255, 0, 0, 0], [0, 255, 0, 255], [10, 20, 30, 0]), 5);
  const result = decode(encoder.finish());
  assert.equal(result.length, 24);
  assert.deepEqual([...result.slice(0, 4)], [255, 0, 0, 255]);
  assert.equal(result[7], 0);
  assert.deepEqual([...result.slice(8, 12)], [10, 20, 30, 255]);
  assert.equal(result[15], 0);
  assert.deepEqual([...result.slice(16, 20)], [0, 255, 0, 255]);
  assert.equal(result[23], 0);
});

test('independent FFmpeg exact palettes and all LZW widths including dictionary resets', { skip: !ffmpegAvailable }, () => {
  for (const colourCount of [1, 3, 7, 15, 31, 63, 127, 255]) {
    const width = 400;
    const height = 300;
    const source = new Uint8ClampedArray(width * height * 4);
    let random = 0x12345678;
    for (let i = 0; i < source.length; i += 4) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const colour = random % colourCount;
      source.set([colour, (colour * 31) & 255, (colour * 67) & 255, 255], i);
    }
    const encoder = new GifEncoder(width, height);
    encoder.addFrame(source, 1);
    const result = decode(encoder.finish());
    assert.equal(result.length, source.length);
    assert.deepEqual(result, Buffer.from(source), `${colourCount} colours round-trip`);
  }
});

test('median cut keeps gradients within a reasonable RGB error', { skip: !ffmpegAvailable }, () => {
  const width = 64;
  const height = 64;
  const source = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    source.set([x * 4, y * 4, (x + y) * 2, 255], (y * width + x) * 4);
  }
  const encoder = new GifEncoder(width, height);
  encoder.addFrame(source);
  const bytes = encoder.finish();
  assert.equal(inspect(bytes).frames[0].palette.length, 768);
  const result = decode(bytes);
  let totalError = 0;
  for (let i = 0; i < source.length; i++) {
    if (i % 4 === 3) assert.equal(result[i], 255);
    else totalError += Math.abs(source[i] - result[i]);
  }
  assert.ok(totalError / (width * height * 3) < 10, 'mean channel error below 10/255');
});

test('compression respects byte cap during large noisy frames', () => {
  const source = new Uint8ClampedArray(512 * 512 * 4);
  let random = 1;
  for (let i = 0; i < source.length; i += 4) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    source.set([random & 255, (random >>> 8) & 255, (random >>> 16) & 255, 255], i);
  }
  const encoder = new GifEncoder(512, 512, { maxBytes: 4096 });
  assert.throws(() => encoder.addFrame(source), /maxBytes/);
  assert.ok(encoder.byteLength < 4096);
  assert.equal(encoder.chunks.length, 0);
});
