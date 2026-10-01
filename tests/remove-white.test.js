'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { removeWhiteBackground } = require('../utils/remove-white');

function pixels(...colours) {
  return new Uint8ClampedArray(colours.flat());
}

const white = [255, 255, 255, 255];
const black = [0, 0, 0, 255];

test('pure white becomes transparent without modifying source', () => {
  const source = pixels(white, white, white, white);
  const original = source.slice();
  const result = removeWhiteBackground(source, 2, 2);
  assert.equal(result.removedPixels, 4);
  assert.deepEqual([...result.data].filter((_, index) => index % 4 === 3), [0, 0, 0, 0]);
  assert.deepEqual(source, original);
  assert.notEqual(result.data, source);
});

test('dark and pale coloured pixels are preserved', () => {
  const source = pixels(black, [255, 230, 230, 255], [235, 255, 235, 255], [230, 230, 255, 255]);
  const result = removeWhiteBackground(source, 4, 1, { mode: 'all' });
  assert.equal(result.removedPixels, 0);
  assert.deepEqual(result.data, source);
});

test('edge mode preserves enclosed white; all mode removes it', () => {
  const source = pixels(black, black, black, black, white, black, black, black, black);
  const edge = removeWhiteBackground(source, 3, 3);
  const all = removeWhiteBackground(source, 3, 3, { mode: 'all' });
  assert.equal(edge.removedPixels, 0);
  assert.equal(edge.data[19], 255);
  assert.equal(all.removedPixels, 1);
  assert.equal(all.data[19], 0);
});

test('connectivity is four-neighbour, never diagonal', () => {
  const source = pixels(white, black, black, black, white, black, black, black, black);
  const result = removeWhiteBackground(source, 3, 3);
  assert.equal(result.removedPixels, 1);
  assert.equal(result.data[3], 0);
  assert.equal(result.data[19], 255);
});

test('near-white boundary and contiguous interior are removed', () => {
  const source = pixels([240, 242, 241, 255], white, black, black, white, black);
  const result = removeWhiteBackground(source, 3, 2);
  assert.equal(result.removedPixels, 3);
  assert.equal(result.data[3], 0);
  assert.equal(result.data[7], 0);
  assert.equal(result.data[19], 0);
});

test('feather scales existing alpha and preserves fully transparent pixel data', () => {
  const source = pixels([219, 219, 219, 120], [1, 2, 3, 0], [200, 200, 200, 100]);
  const result = removeWhiteBackground(source, 3, 1, { tolerance: 32, feather: 12 });
  assert.equal(result.data[3], 40);
  assert.deepEqual([...result.data.slice(4, 8)], [1, 2, 3, 0]);
  assert.equal(result.data[11], 100);
  assert.equal(result.removedPixels, 1);
});

test('transparent pixels connect a background region to the image boundary', () => {
  const source = pixels(black, [0, 0, 0, 0], black, black, white, black, black, black, black);
  const result = removeWhiteBackground(source, 3, 3);
  assert.equal(result.data[19], 0);
  assert.equal(result.removedPixels, 1);
  assert.deepEqual([...result.data.slice(4, 8)], [0, 0, 0, 0]);
});

test('zero feather and zero tolerance do not cause division errors', () => {
  const source = pixels(white, [254, 254, 254, 128]);
  const result = removeWhiteBackground(source, 2, 1, { tolerance: 0, feather: 0 });
  assert.equal(result.data[3], 0);
  assert.equal(result.data[7], 128);
});

test('non-square image uses the actual row width for vertical connectivity', () => {
  const colours = Array.from({ length: 35 }, () => black);
  colours[3] = white;
  colours[10] = white;
  colours[17] = white;
  colours[15] = white;
  const result = removeWhiteBackground(pixels(...colours), 7, 5);
  assert.equal(result.removedPixels, 3);
  assert.equal(result.data[17 * 4 + 3], 0);
  assert.equal(result.data[15 * 4 + 3], 255);
});

test('single-row and single-column images visit each pixel once', () => {
  const source = pixels(white, white, black, white);
  for (const [width, height] of [[4, 1], [1, 4]]) {
    const result = removeWhiteBackground(source, width, height);
    assert.equal(result.removedPixels, 3);
    assert.equal(result.data[11], 255);
  }
});

test('rejects malformed input and invalid options', () => {
  assert.throws(() => removeWhiteBackground([255, 255, 255, 255], 1, 1), TypeError);
  for (const [width, height] of [[0, 1], [-1, 1], [1.5, 1], [1, NaN], [2048, 2049]]) {
    assert.throws(() => removeWhiteBackground(pixels(white), width, height), RangeError);
  }
  assert.throws(() => removeWhiteBackground(pixels(white), 2, 1), RangeError);
  for (const options of [{ mode: 'invalid' }, { tolerance: -1 }, { tolerance: NaN },
    { tolerance: 256 }, { feather: Infinity }, { feather: '12' }]) {
    assert.throws(() => removeWhiteBackground(pixels(white), 1, 1, options), RangeError);
  }
  assert.throws(() => removeWhiteBackground(pixels(white), 1, 1, null), TypeError);
});

test('2048² all-white flood fill stays bounded and finishes promptly', () => {
  const source = new Uint8ClampedArray(2048 * 2048 * 4).fill(255);
  const start = performance.now();
  const result = removeWhiteBackground(source, 2048, 2048);
  const elapsed = performance.now() - start;
  assert.equal(result.removedPixels, 2048 * 2048);
  assert.equal(result.data[3], 0);
  assert.equal(result.data[result.data.length - 1], 0);
  assert.equal(source[3], 255);
  // Broad regression guard for accidental quadratic traversal, not a device SLA.
  assert.ok(elapsed < 15000, `large-image processing took ${elapsed.toFixed(0)} ms`);
});
