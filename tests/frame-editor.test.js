'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStroke, renderEditedFrame, resizeFrame } = require('../utils/frame-editor');

function frame(width, height, colour = [80, 90, 100, 255]) {
  const result = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) result.set(colour, index * 4);
  return result;
}
function stroke(tool, radius, points) { return { tool, radius, points }; }
function alpha(data, width, x, y) { return data[(y * width + x) * 4 + 3]; }

test('erase modifies only alpha inside a circular brush and leaves original intact', () => {
  const original = frame(7, 7);
  const snapshot = original.slice();
  const target = original.slice();
  applyStroke(target, original, 7, 7, stroke('erase', 2, [{ x: 3.5, y: 3.5 }]));
  assert.equal(alpha(target, 7, 3, 3), 0);
  assert.equal(alpha(target, 7, 5, 3), 0);
  assert.equal(alpha(target, 7, 5, 5), 255);
  assert.deepEqual([...target.slice((3 * 7 + 3) * 4, (3 * 7 + 3) * 4 + 3)], [80, 90, 100]);
  assert.deepEqual(original, snapshot);
});

test('restore copies original RGBA including transparent and partial alpha', () => {
  const original = new Uint8ClampedArray([20, 30, 40, 0, 50, 60, 70, 90, 80, 90, 100, 255]);
  const target = frame(3, 1, [1, 2, 3, 0]);
  applyStroke(target, original, 3, 1, stroke('restore', 3, [{ x: 1.5, y: 0.5 }]));
  assert.deepEqual(target, original);
});

test('fast horizontal and diagonal drags have no gaps', () => {
  const original = frame(30, 30);
  const target = original.slice();
  applyStroke(target, original, 30, 30, stroke('erase', 1, [{ x: 0.5, y: 10.5 }, { x: 29.5, y: 10.5 }]));
  for (let x = 0; x < 30; x += 1) assert.equal(alpha(target, 30, x, 10), 0);
  const diagonal = original.slice();
  applyStroke(diagonal, original, 30, 30, stroke('erase', 1, [{ x: 0.5, y: 0.5 }, { x: 29.5, y: 29.5 }]));
  for (let index = 0; index < 30; index += 1) assert.equal(alpha(diagonal, 30, index, index), 0);
});

test('off-image segments are clipped and distant brushes do nothing', () => {
  const original = frame(10, 5);
  const target = original.slice();
  applyStroke(target, original, 10, 5, stroke('erase', 1, [{ x: -1000000, y: 2.5 }, { x: 1000000, y: 2.5 }]));
  for (let x = 0; x < 10; x += 1) assert.equal(alpha(target, 10, x, 2), 0);
  const untouched = original.slice();
  applyStroke(untouched, original, 10, 5, stroke('erase', 2, [{ x: -1000, y: -1000 }, { x: -900, y: -900 }]));
  applyStroke(untouched, original, 10, 5, stroke('erase', 2, [{ x: 1000, y: 1000 }]));
  assert.deepEqual(untouched, original);
});

test('a brush centred on an image corner clips safely', () => {
  const original = frame(3, 3);
  const target = original.slice();
  applyStroke(target, original, 3, 3, stroke('erase', 1, [{ x: 0, y: 0 }]));
  assert.equal(alpha(target, 3, 0, 0), 0);
  assert.equal(alpha(target, 3, 1, 0), 255);
  assert.equal(target.length, original.length);
});

test('ordered replay supports undo without mutating base, original, or other frames', () => {
  const original = frame(6, 4);
  const base = original.slice();
  base[3] = 0;
  const originalSnapshot = original.slice();
  const baseSnapshot = base.slice();
  const erase = stroke('erase', 2, [{ x: 3.5, y: 2.5 }]);
  const restore = stroke('restore', 1, [{ x: 3.5, y: 2.5 }]);
  const edited = renderEditedFrame(base, original, 6, 4, [erase, restore]);
  const undone = renderEditedFrame(base, original, 6, 4, [erase]);
  const reset = renderEditedFrame(base, original, 6, 4, []);
  assert.equal(alpha(edited, 6, 3, 2), 255);
  assert.equal(alpha(undone, 6, 3, 2), 0);
  assert.deepEqual(reset, base);
  edited[3] = 123;
  assert.equal(undone[3], 0);
  assert.equal(reset[3], 0);
  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(original, originalSnapshot);
});

test('empty and stationary strokes are safe', () => {
  const original = frame(3, 3);
  const target = original.slice();
  applyStroke(target, original, 3, 3, stroke('erase', 1, []));
  assert.deepEqual(target, original);
  applyStroke(target, original, 3, 3, stroke('erase', 1, [{ x: 1.5, y: 1.5 }, { x: 1.5, y: 1.5 }]));
  assert.equal(alpha(target, 3, 1, 1), 0);
});

test('invalid strokes are rejected before any pixels change', () => {
  const original = frame(3, 3);
  for (const bad of [stroke('other', 1, []), stroke('erase', 0, []), stroke('erase', 41, []),
    stroke('erase', NaN, []), stroke('erase', 1, [{ x: 1, y: 1 }, { x: NaN, y: 2 }]),
    stroke('erase', 1, [{ x: Infinity, y: 0 }]), stroke('erase', 1, [{ x: -1e308, y: 0 }, { x: 1e308, y: 0 }])]) {
    const target = original.slice();
    assert.throws(() => applyStroke(target, original, 3, 3, bad));
    assert.deepEqual(target, original);
  }
  assert.throws(() => applyStroke(original, original, 3, 3, stroke('erase', 1, [])), TypeError);
  assert.throws(() => applyStroke(original.slice(), original, 3, 3,
    stroke('erase', 1, Array.from({ length: 1025 }, () => ({ x: 1, y: 1 })))), RangeError);
});

test('nearest-neighbour resize preserves colour and transparency without mutation', () => {
  const source = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 200, 100, 110, 120, 255]);
  const snapshot = source.slice();
  const up = resizeFrame(source, 2, 2, 4, 4);
  assert.deepEqual([...up.slice(0, 8)], [10, 20, 30, 0, 10, 20, 30, 0]);
  assert.deepEqual([...up.slice(8, 12)], [40, 50, 60, 128]);
  assert.deepEqual([...up.slice(60, 64)], [100, 110, 120, 255]);
  const down = resizeFrame(source, 2, 2, 1, 1);
  assert.deepEqual([...down], [10, 20, 30, 0]);
  assert.deepEqual(source, snapshot);
  assert.notEqual(resizeFrame(source, 2, 2, 2, 2), source);
});

test('dimension validation rejects bad source and target sizes', () => {
  const source = frame(2, 2);
  assert.throws(() => resizeFrame([], 2, 2, 1, 1), TypeError);
  for (const [width, height] of [[0, 2], [2.5, 2], [2048, 2049], [2, Infinity], [3, 2]]) {
    assert.throws(() => resizeFrame(source, width, height, 1, 1), RangeError);
  }
  for (const [width, height] of [[0, 1], [1, NaN], [2048, 2049]]) {
    assert.throws(() => resizeFrame(source, 2, 2, width, height), RangeError);
  }
  assert.throws(() => renderEditedFrame(source, source, 2, 2, null), TypeError);
});

test('paint covers with sampled RGB and full alpha, without erasing the subject', () => {
  const original = frame(5, 5, [40, 60, 80, 255]);
  const base = original.slice();
  base.set([250, 250, 250, 120], 12 * 4);
  const paint = { tool: 'paint', radius: 1, points: [{ x: 2.5, y: 2.5 }], color: [40, 60, 80] };
  const edited = renderEditedFrame(base, original, 5, 5, [paint]);
  assert.deepEqual([...edited.slice(48, 52)], [40, 60, 80, 255]);
  assert.deepEqual(renderEditedFrame(base, original, 5, 5, []), base, 'undo removes paint');
  assert.deepEqual(original.slice(48, 52), new Uint8ClampedArray([40, 60, 80, 255]));
});

test('paint rejects invalid colour channels before modifying pixels', () => {
  const original = frame(3, 3);
  for (const color of [undefined, [], [0, 1], [0, 1, 2, 3], [-1, 1, 2], [256, 1, 2], [1.2, 1, 2], [NaN, 1, 2]]) {
    const target = original.slice();
    assert.throws(() => applyStroke(target, original, 3, 3, { tool: 'paint', radius: 1, points: [{ x: 1.5, y: 1.5 }], color }));
    assert.deepEqual(target, original);
  }
});
