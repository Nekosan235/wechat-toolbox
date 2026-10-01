function clampZoom(value) {
  return Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : 1
}

// Preview-only transform. Image data and export dimensions never change.
function createEditorView(imageWidth, imageHeight, viewportWidth, viewportHeight, state = {}) {
  if (![imageWidth, imageHeight, viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Invalid editor viewport dimensions')
  }
  const zoom = clampZoom(state.zoom)
  const scale = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight) * zoom
  const width = imageWidth * scale
  const height = imageHeight * scale
  const limitX = Math.max(0, (width - viewportWidth) / 2)
  const limitY = Math.max(0, (height - viewportHeight) / 2)
  const panX = Math.max(-limitX, Math.min(limitX, Number.isFinite(state.panX) ? state.panX : 0)) || 0
  const panY = Math.max(-limitY, Math.min(limitY, Number.isFinite(state.panY) ? state.panY : 0)) || 0
  return { zoom, panX, panY, scale, width, height,
    x: (viewportWidth - width) / 2 + panX, y: (viewportHeight - height) / 2 + panY }
}

function viewPoint(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale }
}

module.exports = { createEditorView, viewPoint, clampZoom }
