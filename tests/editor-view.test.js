const test = require('node:test')
const assert = require('node:assert/strict')
const { createEditorView, viewPoint, clampZoom } = require('../utils/editor-view')

test('fit preserves aspect ratio and letterbox coordinates', () => {
  const view = createEditorView(400, 200, 200, 200)
  assert.equal(view.scale, .5)
  assert.equal(view.x, 0)
  assert.equal(view.y, 50)
  assert.deepEqual(viewPoint(view, { x: 100, y: 100 }), { x: 200, y: 100 })
})
test('zoom and pan invert back to original image pixels', () => {
  const view = createEditorView(400, 200, 200, 200, { zoom: 4, panX: -80, panY: 30 })
  const pixel = { x: 212.5, y: 65.5 }
  assert.deepEqual(viewPoint(view, { x: view.x + pixel.x * view.scale, y: view.y + pixel.y * view.scale }), pixel)
})
test('pan clamps at image boundaries, with no movement on fitted letterboxed axes', () => {
  const fitted = createEditorView(400, 200, 200, 200, { zoom: 1, panX: 100, panY: -100 })
  assert.equal(fitted.panX, 0)
  assert.equal(fitted.panY, 0)
  const zoomed = createEditorView(400, 200, 200, 200, { zoom: 4, panX: 1e6, panY: -1e6 })
  assert.equal(zoomed.x, 0)
  assert.equal(zoomed.y + zoomed.height, 200)
})
test('zoom bounds and malformed state cannot create unbounded or invalid transforms', () => {
  assert.equal(clampZoom(-10), 1)
  assert.equal(clampZoom(100), 8)
  assert.equal(clampZoom(NaN), 1)
  assert.equal(createEditorView(2, 2, 100, 100, { zoom: Infinity, panX: NaN }).scale, 50)
  assert.throws(() => createEditorView(0, 2, 100, 100), RangeError)
})
