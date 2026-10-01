const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGif, composeGifFrames } = require('../utils/gif-decoder');

const WHITE = [255, 255, 255, 255];
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 255, 0, 255];
const CLEAR = [0, 0, 0, 0];
const PALETTE = [255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0];
const word = n => [n & 255, n >> 8];
const ascii = s => Array.from(s, ch => ch.charCodeAt(0));

// Hand-authored GIF containers: direct color codes with a clear before each
// pixel keep each code at three bits. No production encoder is used here.
function packCodes(codes) {
  const bytes = [];
  let position = 0;
  for (const [code, width] of codes) {
    for (let bit = 0; bit < width; bit++, position++) {
      const offset = position >> 3;
      bytes[offset] = (bytes[offset] || 0) | (((code >> bit) & 1) << (position & 7));
    }
  }
  return bytes;
}

function fixture(options = {}) {
  const width = options.width || 1;
  const height = options.height || 1;
  const global = options.global !== false;
  const bytes = [...ascii(options.version || 'GIF89a'), ...word(width), ...word(height),
    global ? 0x81 : 0, options.background || 0, 0];
  if (global) bytes.push(...PALETTE);
  if (options.loop !== undefined) {
    bytes.push(0x21, 0xff, 11, ...ascii('NETSCAPE2.0'), 3, 1, ...word(options.loop), 0);
  }
  for (const frame of options.frames || [{ indices: [1] }]) {
    if (frame.control !== false) {
      bytes.push(0x21, 0xf9, 4, ((frame.disposal || 0) << 2) | (frame.transparent === undefined ? 0 : 1),
        ...word(frame.delay || 0), frame.transparent || 0, 0);
    }
    const local = frame.palette;
    bytes.push(0x2c, ...word(frame.left || 0), ...word(frame.top || 0),
      ...word(frame.width || width), ...word(frame.height || height),
      (frame.interlaced ? 64 : 0) | (local ? 0x81 : 0));
    if (local) bytes.push(...local);
    const codes = frame.codes || (frame.indices || [1]).flatMap(index => [[4, 3], [index, 3]]).concat([[5, 3]]);
    const data = frame.compressed || packCodes(codes);
    bytes.push(frame.minCodeSize || 2);
    for (let offset = 0; offset < data.length; offset += 255) {
      const block = data.slice(offset, offset + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

function render(options) {
  return [...composeGifFrames(parseGif(fixture(options)))];
}

function pixels(frame) {
  return Array.from({ length: frame.data.length / 4 }, (_, i) => Array.from(frame.data.slice(i * 4, i * 4 + 4)));
}

test('parses GIF87a/89a, ArrayBuffer and offset Uint8Array without retaining RGBA', () => {
  for (const version of ['GIF87a', 'GIF89a']) {
    const bytes = fixture({ version, loop: 0, frames: [{ indices: [1], delay: 7 }] });
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 4);
    const gif = parseGif(padded.subarray(4, bytes.length + 4));
    assert.equal(gif.frameCount, 1);
    assert.equal(gif.totalDurationMs, 70);
    assert.equal(gif.loopCount, 0);
    assert.equal(gif.frames[0].delay, 7);
    assert.equal(gif.frames[0].data, undefined);
    assert.deepEqual(pixels([...composeGifFrames(gif)][0]), [RED]);
    assert.equal(parseGif(bytes.buffer).width, 1);
  }
});

test('absent loop is null, finite loop is retained and zero delay estimates 100 ms', () => {
  assert.equal(parseGif(fixture()).loopCount, null);
  const gif = parseGif(fixture({ loop: 3 }));
  assert.equal(gif.loopCount, 3);
  assert.equal(gif.totalDurationMs, 100);
  assert.equal([...composeGifFrames(gif)][0].delay, 0);
});

test('initial logical background fills areas outside frame', () => {
  assert.deepEqual(pixels(render({ width: 3, frames: [{ width: 1, left: 1, indices: [1] }] })[0]),
    [WHITE, RED, WHITE]);
});

test('transparent global background and transparent pixels preserve underlying canvas', () => {
  const frames = render({ width: 2, frames: [
    { indices: [0, 1], transparent: 0 },
    { indices: [2, 0], transparent: 0 }
  ] });
  assert.deepEqual(pixels(frames[0]), [CLEAR, RED]);
  assert.deepEqual(pixels(frames[1]), [BLUE, RED]);
});

test('transparent initial background does not require matching the global background index', () => {
  const frames = render({ width: 2, frames: [{ width: 1, indices: [1], transparent: 3 }] });
  assert.deepEqual(pixels(frames[0]), [RED, CLEAR]);
});

test('local palettes, no global palette and frame offsets', () => {
  const palette = [0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  assert.deepEqual(pixels(render({ width: 2, height: 2, global: false,
    frames: [{ width: 1, height: 1, left: 1, top: 1, palette, indices: [2] }] })[0]),
  [CLEAR, CLEAR, CLEAR, [40, 50, 60, 255]]);
});

test('interlace uses row order 0, 4, 2, 6, 1, 3, 5, 7', () => {
  const frame = render({ height: 8, frames: [{ interlaced: true, indices: [0, 1, 2, 3, 1, 2, 3, 0] }] })[0];
  assert.deepEqual(pixels(frame), [WHITE, RED, BLUE, BLUE, RED, GREEN, GREEN, WHITE]);
});

test('disposal 0 and 1 retain prior frame', () => {
  for (const disposal of [0, 1]) {
    const frames = render({ width: 2, frames: [
      { width: 1, indices: [1], disposal },
      { width: 1, left: 1, indices: [2] }
    ] });
    assert.deepEqual(pixels(frames[1]), [RED, BLUE]);
  }
});

test('disposal 2 clears only frame rectangle to opaque or transparent background', () => {
  for (const transparent of [undefined, 0]) {
    const frames = render({ width: 3, frames: [
      { indices: [1, 1, 1], transparent },
      { width: 1, left: 1, indices: [2], disposal: 2, transparent },
      { width: 1, left: 2, indices: [3], transparent }
    ] });
    assert.deepEqual(pixels(frames[1]), [RED, BLUE, RED]);
    assert.deepEqual(pixels(frames[2]), [RED, transparent === undefined ? WHITE : CLEAR, GREEN]);
  }
});

test('disposal 3 restores canvas from before the frame and yielded arrays are independent', () => {
  const frames = render({ width: 2, frames: [
    { indices: [1, 1] },
    { width: 1, indices: [2], disposal: 3 },
    { width: 1, left: 1, indices: [3] }
  ] });
  assert.deepEqual(pixels(frames[0]), [RED, RED]);
  assert.deepEqual(pixels(frames[1]), [BLUE, RED]);
  assert.deepEqual(pixels(frames[2]), [RED, GREEN]);
  frames[0].data.fill(0);
  assert.deepEqual(pixels(frames[1]), [BLUE, RED]);
});

test('control extension applies only to following frame', () => {
  const gif = parseGif(fixture({ frames: [
    { indices: [1], transparent: 0, delay: 12, disposal: 2 },
    { indices: [1], control: false }
  ] }));
  assert.equal(gif.frames[1].delay, 0);
  assert.equal(gif.frames[1].transparentIndex, null);
  assert.equal(gif.frames[1].disposal, 0);
});

test('LZW handles dictionary growth and next-code special case', () => {
  const growth = [[4, 3], [0, 3], [1, 3], [2, 3], [3, 4], [0, 4], [1, 4], [2, 4], [5, 4]];
  assert.deepEqual(pixels(render({ width: 7, frames: [{ codes: growth }] })[0]),
    [WHITE, RED, BLUE, GREEN, WHITE, RED, BLUE]);
  const special = [[4, 3], [0, 3], [6, 3], [7, 3], [5, 4]];
  assert.deepEqual(pixels(render({ width: 6, frames: [{ codes: special }] })[0]), Array(6).fill(WHITE));
});

test('LZW grows through 12 bits, freezes a full dictionary and resets on clear', () => {
  const indices = Array.from({ length: 20000 }, (_, i) => (i * 17 + (i >> 3)) & 3);
  const codes = [[4, 3]];
  for (let i = 0; i < indices.length; i++) {
    const entriesBeforeCode = Math.min(4096, 6 + Math.max(0, i - 1));
    codes.push([indices[i], Math.min(12, Math.floor(Math.log2(entriesBeforeCode)) + 1)]);
  }
  codes.push([4, 12], [3, 3], [5, 3]);
  const frame = render({ width: 177, height: 113, frames: [{ codes }] })[0];
  const colors = [WHITE, RED, BLUE, GREEN];
  assert.deepEqual(pixels(frame), indices.concat([3]).map(index => colors[index]));
});

test('rejects every truncated prefix, missing frames, signatures and invalid types', () => {
  const bytes = fixture();
  for (let length = 0; length < bytes.length; length++) {
    assert.throws(() => parseGif(bytes.subarray(0, length)), /GIF/);
  }
  assert.throws(() => parseGif(fixture({ frames: [] })), /没有图像帧/);
  assert.throws(() => parseGif(fixture({ version: 'NOTGIF' })), /不是 GIF/);
  assert.throws(() => parseGif('gif'), /ArrayBuffer/);
});

test('rejects dimensions, durations, frames and invalid limits', () => {
  const bytes = fixture({ width: 2, height: 2, frames: [{ indices: [1, 1, 1, 1], delay: 20 }] });
  assert.throws(() => parseGif(bytes, { maxWidth: 1 }), /尺寸/);
  assert.throws(() => parseGif(bytes, { maxHeight: 1 }), /尺寸/);
  assert.throws(() => parseGif(bytes, { maxPixels: 3 }), /尺寸/);
  assert.throws(() => parseGif(bytes, { maxDurationMs: 100 }), /时长/);
  assert.throws(() => parseGif(fixture({ frames: [{ indices: [1] }, { indices: [1] }] }), { maxFrames: 1 }), /帧数/);
  assert.throws(() => parseGif(bytes, { maxWidth: Infinity }), /限制/);
});

test('rejects out-of-canvas frames, missing palette and invalid control indices', () => {
  assert.throws(() => parseGif(fixture({ frames: [{ left: 1, indices: [1] }] })), /越界/);
  assert.throws(() => parseGif(fixture({ global: false })), /颜色表/);
  assert.throws(() => parseGif(fixture({ background: 4 })), /背景/);
  assert.throws(() => parseGif(fixture({ frames: [{ transparent: 4 }] })), /透明/);
  assert.throws(() => parseGif(fixture({ frames: [{ disposal: 4 }] })), /处置/);
  assert.throws(() => parseGif(fixture({ frames: [{ minCodeSize: 9 }] })), /位数/);
});

test('rejects malformed LZW streams and mismatched decoded pixel count', () => {
  const cases = [
    { codes: [[0, 3], [5, 3]] },
    { codes: [[4, 3], [6, 3], [5, 3]] },
    { codes: [[4, 3], [0, 3], [7, 3], [5, 3]] },
    { codes: [[4, 3], [5, 3]] },
    { indices: [0, 0] },
    { compressed: [0] }
  ];
  for (const frame of cases) assert.throws(() => render({ frames: [frame] }), /LZW/);
  // An eight-color alphabet may still use a four-entry table: index 4 is invalid.
  assert.throws(() => render({ frames: [{ minCodeSize: 3, codes: [[8, 4], [4, 4], [9, 4]] }] }), /颜色索引/);
});

test('many clear codes are bounded by input length and cannot cause dictionary cycles', () => {
  const codes = Array.from({ length: 10000 }, () => [4, 3]);
  codes.push([1, 3], [5, 3]);
  assert.deepEqual(pixels(render({ frames: [{ codes }] })[0]), [RED]);
});
