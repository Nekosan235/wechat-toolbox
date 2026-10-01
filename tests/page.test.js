const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

const pagePath = path.join(__dirname, '../pages/index/index.js')

function createFixture(options = {}) {
  const width = options.width || 5
  const height = options.height || 5
  const pixels = options.pixels || new Uint8ClampedArray(width * height * 4).fill(255)
  // White border, dark ring, and an enclosed white center.
  if (!options.pixels && width === 5 && height === 5) {
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) {
        if (x !== 2 || y !== 2) pixels.set([25, 65, 45, 255], (y * width + x) * 4)
      }
    }
  }
  const state = { exports: [], saves: [], toasts: [], selectCalls: 0 }
  const context = {
    clearRect() {},
    drawImage() {},
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, arc() {},
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: w === width && h === height
        ? new Uint8ClampedArray(pixels)
        : new Uint8ClampedArray(w * h * 4).fill(255) }
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
    },
    putImageData(image) { state.rendered = image }
  }
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    createImage() {
      return { width, height, set src(value) { queueMicrotask(() => this.onload()) } }
    }
  }
  const previewContext = {
    clearRect() {},
    drawImage(...args) { state.previewDraw = args }
  }
  const previewCanvas = { width: 0, height: 0, getContext: () => previewContext }
  const wx = {
    createSelectorQuery() {
      return {
        in() { return this }, select(selector) { this.selector = selector; return this }, fields() { return this },
        exec(callback) {
          callback([this.selector === '#editor-canvas'
            ? { node: previewCanvas, width: options.previewWidth || 200,
              height: options.previewHeight || 200, left: 10, top: 40 }
            : { node: canvas }])
        }
      }
    },
    chooseMedia(request) {
      state.selectCalls++
      if (options.cancel) request.fail({ errMsg: 'chooseMedia:fail cancel' })
      else request.success({ tempFiles: [{ tempFilePath: 'mock://photo.png', size: options.size || 100 }] })
    },
    getImageInfo(request) {
      request.success({ width, height, type: options.type || 'png' })
    },
    canvasToTempFilePath(request) {
      state.exports.push({ ...request, data: new Uint8ClampedArray(state.rendered
        ? state.rendered.data : context.getImageData(0, 0, canvas.width, canvas.height).data) })
      if (options.failExport) request.fail({ errMsg: 'canvasToTempFilePath:fail' })
      else request.success({ tempFilePath: 'wxfile://result-' + state.exports.length + '.png' })
    },
    saveImageToPhotosAlbum(request) {
      state.saves.push(request.filePath)
      if (options.denySave) request.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
      else request.success({})
    },
    showToast(value) { state.toasts.push(value) },
    previewImage(value) { state.preview = value },
    navigateTo(value) { state.navigation = value },
    showModal() {}
  }
  let definition
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page: value => { definition = value }, wx, setTimeout, clearTimeout, Uint8ClampedArray,
    require: createRequire(pagePath), console: { warn() {} }
  }, { filename: pagePath })
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) }
  }
  return { page, state, canvas, pixels, options, context }
}

test('select -> remove -> preview -> save passes an actual transparent PNG export', async () => {
  const { page, state } = createFixture()
  assert.equal(page.data.resultPath, '')
  await page.chooseImage()
  assert.equal(page.data.isLoading, false)
  assert.equal(page.data.imageSize, '5 × 5')
  assert.equal(page.data.removedPercent, '64.0')
  const exported = state.exports[0]
  assert.equal(exported.fileType, 'png')
  assert.equal(exported.destWidth, 5)
  assert.equal(exported.destHeight, 5)
  assert.equal(exported.data[3], 0, 'background has real zero alpha')
  assert.equal(exported.data[(2 * 5 + 2) * 4 + 3], 255, 'enclosed white stays opaque')
  page.previewImage()
  assert.equal(state.preview.current, page.data.resultPath)
  await page.saveImage()
  assert.deepEqual(state.saves, [page.data.resultPath])
  assert.equal(page.data.isSaving, false)
})

test('changing mode recomputes from original and can recover removed white', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  await page.changeMode({ detail: { value: true } })
  assert.equal(state.exports[1].data[(2 * 5 + 2) * 4 + 3], 0)
  await page.changeMode({ detail: { value: false } })
  assert.equal(state.exports[2].data[(2 * 5 + 2) * 4 + 3], 255)
  assert.equal(page._original.data[3], 255)
})

test('preview backgrounds do not re-render or enter exported pixels', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  const result = page.data.resultPath
  page.switchBackground({ currentTarget: { dataset: { background: 'dark' } } })
  assert.equal(page.data.previewBackground, 'dark')
  assert.equal(state.exports.length, 1)
  assert.equal(page.data.resultPath, result)
  assert.equal(state.exports[0].data[3], 0)
})

test('canceling selection retains the previous image and result', async () => {
  const { page, state } = createFixture({ cancel: true })
  page.setData({ originalPath: 'previous-original', resultPath: 'previous-result' })
  await page.chooseImage()
  assert.equal(page.data.originalPath, 'previous-original')
  assert.equal(page.data.resultPath, 'previous-result')
  assert.equal(page.data.errorText, '')
  assert.equal(page.data.isLoading, false)
  assert.equal(state.toasts.length, 0)
})

test('large image is constrained to a 2048-pixel long edge with correct PNG size', async () => {
  const { page, state } = createFixture({ width: 4096, height: 2 })
  await page.chooseImage()
  assert.equal(page.data.imageSize, '2048 × 1')
  assert.equal(page.data.wasResized, true)
  assert.equal(state.exports[0].destWidth, 2048)
  assert.equal(state.exports[0].destHeight, 1)
})

test('oversized files and GIF are rejected without exporting', async () => {
  for (const options of [{ size: 10 * 1024 * 1024 + 1 }, { type: 'gif' }]) {
    const { page, state } = createFixture(options)
    await page.chooseImage()
    assert.notEqual(page.data.errorText, '')
    assert.equal(page.data.isLoading, false)
    assert.equal(state.exports.length, 0)
  }
})

test('failed export is not treated as a saveable result', async () => {
  const { page, state } = createFixture({ failExport: true })
  await page.chooseImage()
  assert.equal(page.data.resultPath, '')
  assert.equal(page.data.isLoading, false)
  await page.saveImage()
  assert.equal(state.saves.length, 0)
})

test('album denial shows recovery, and settings authorization clears it', async () => {
  const { page } = createFixture({ denySave: true })
  await page.chooseImage()
  await page.saveImage()
  assert.equal(page.data.needsAlbumPermission, true)
  assert.equal(page.data.isSaving, false)
  page.onAlbumSetting({ detail: { authSetting: { 'scope.writePhotosAlbum': true } } })
  assert.equal(page.data.needsAlbumPermission, false)
  assert.equal(page.data.errorText, '')
})

test('busy operations cannot overwrite or save an in-flight result', async () => {
  const { page, state } = createFixture()
  page.setData({ isLoading: true, resultPath: 'old-result' })
  await page.chooseImage()
  await page.saveImage()
  await page.changeMode({ detail: { value: true } })
  assert.equal(state.selectCalls, 0)
  assert.equal(state.saves.length, 0)
  assert.equal(page.data.mode, 'edge')
})

test('failed parameter adjustment preserves the valid result and its settings', async () => {
  const { page, options } = createFixture()
  await page.chooseImage()
  const oldResult = page.data.resultPath
  options.failExport = true
  await page.changeMode({ detail: { value: true } })
  assert.equal(page.data.resultPath, oldResult)
  assert.equal(page.data.mode, 'edge')
  assert.equal(page.data.isLoading, false)
  assert.match(page.data.statusText, /未完成/)
})

test('original dimensions are restored after a failed new-image canvas operation', async () => {
  const { page, canvas, state } = createFixture()
  await page.chooseImage()
  canvas.width = 20
  canvas.height = 10
  await page.changeTolerance({ detail: { value: 20 } })
  assert.equal(page.data.errorText, '')
  assert.equal(state.exports[1].destWidth, 5)
  assert.equal(state.exports[1].destHeight, 5)
})

test('unloading during selection does not mutate or toast after leaving the page', async () => {
  const { page, state } = createFixture()
  const pending = page.chooseImage()
  page.onUnload()
  const snapshot = JSON.stringify(page.data)
  await pending
  assert.equal(JSON.stringify(page.data), snapshot)
  assert.equal(page._canvas, null)
  assert.equal(page._original, null)
  assert.equal(state.exports.length, 0)
  assert.equal(state.toasts.length, 0)
})

function brushEvent(x, y) {
  return { touches: [{ x, y, identifier: 1 }], changedTouches: [{ x, y, identifier: 1 }] }
}

test('manual erase invalidates old PNG immediately and saves newly exported pixels', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  const oldPath = page.data.resultPath
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onBrushStart(brushEvent(100, 100))
  assert.equal(page.data.resultPath, '')
  assert.equal(page.data.isDirty, true)
  assert.equal(page.data.isDrawing, true)
  assert.equal(state.exports.length, 1, 'touch does not export a PNG')
  page.onBrushMove(brushEvent(104, 100))
  page.onBrushEnd()
  assert.equal(page.data.strokeCount, 1)
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 0)
  assert.equal(page._original.data[(2 * 5 + 2) * 4 + 3], 255)
  await page.saveImage()
  assert.equal(state.exports.length, 2)
  assert.notEqual(page.data.resultPath, oldPath)
  assert.equal(state.exports[1].data[(2 * 5 + 2) * 4 + 3], 0)
  assert.deepEqual(state.saves, [page.data.resultPath])
  assert.equal(page.data.isDirty, false)
})

test('undo replays from auto result and restore recovers the original background', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushEnd()
  page.undoStroke()
  assert.equal(page.data.strokeCount, 0)
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 255)
  page.changeBrushTool({ currentTarget: { dataset: { tool: 'restore' } } })
  page.onBrushStart(brushEvent(20, 20))
  page.onBrushEnd()
  assert.equal(page._edited[3], 255)
  page.undoStroke()
  assert.equal(page._edited[3], 0)
})

test('adjusting automatic settings replays manual strokes and new images clear history', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushEnd()
  await page.changeTolerance({ detail: { value: 20 } })
  assert.equal(page.data.strokeCount, 1)
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 0)
  await page.chooseImage()
  assert.equal(page.data.strokeCount, 0)
  assert.equal(page._strokes.length, 0)
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 255)
})

test('example image also clears stroke history', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushEnd()
  await page.useExample()
  assert.equal(page.data.imageSize, '640 × 480')
  assert.equal(page.data.strokeCount, 0)
  assert.equal(page._strokes.length, 0)
  assert.equal(page.data.isDirty, false)
})

test('touch mapping handles letterbox margins and current viewport scrolling', async () => {
  const { page } = createFixture({ previewWidth: 400, previewHeight: 200 })
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onBrushStart(brushEvent(20, 100))
  assert.equal(page._activeStroke, null, 'letterbox touch must not edit')
  page.onPageScroll({ scrollTop: 50 })
  page.onBrushStart({ touches: [{ clientX: 210, clientY: 90, identifier: 1 }] })
  page.onBrushEnd()
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 0)
  assert.equal(page.data.strokeCount, 1)
})

test('opening the shared drawer does not let underlying canvas touches edit the photo', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  page.onDrawerChange({ detail: { open: true } })
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushEnd()
  assert.equal(page.data.strokeCount, 0)
  page.onDrawerChange({ detail: { open: false } })
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushEnd()
  assert.equal(page.data.strokeCount, 1)
})

test('original-view touches, busy operations and excessive history do not edit', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  page.switchPreview({ currentTarget: { dataset: { mode: 'original' } } })
  page.onBrushStart(brushEvent(100, 100))
  assert.equal(page.data.strokeCount, 0)
  page.switchPreview({ currentTarget: { dataset: { mode: 'result' } } })
  page._strokes = Array.from({ length: 100 }, () => ({ tool: 'erase', radius: 1, points: [] }))
  page.onBrushStart(brushEvent(100, 100))
  assert.equal(page.data.isDrawing, false)
  assert.match(state.toasts.at(-1).title, /100/)
  page.openGifEditor()
  assert.equal(state.navigation.url, '/pages/gif/index')
})

test('pending drawing is canceled on unload without exports or page updates', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  page.onBrushStart(brushEvent(100, 100))
  page.onUnload()
  const snapshot = JSON.stringify(page.data)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(JSON.stringify(page.data), snapshot)
  assert.equal(state.exports.length, 1)
  assert.equal(page._edited, null)
})

test('a long stroke is committed once at the point cap, including touch-end handling', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  page.onBrushStart(brushEvent(100, 100))
  page._activeStroke.points = Array.from({ length: 1024 }, () => ({ x: 2.5, y: 2.5 }))
  page.onBrushEnd(brushEvent(104, 100))
  assert.equal(page.data.isDrawing, false)
  assert.equal(page.data.strokeCount, 1)
  assert.equal(page._strokes.length, 1)
  assert.equal(page._strokes[0].points.length, 1024)
  assert.match(state.toasts.at(-1).title, /过长/)
  page.undoStroke()
  assert.equal(page.data.strokeCount, 0)
})

function toolEvent(tool) { return { currentTarget: { dataset: { tool } } } }
function zoomEvent(step) { return { currentTarget: { dataset: { step } } } }

test('zoom clamps to 1..8 and does not change pixels, export size, or valid PNG', async () => {
  const { page, state, canvas } = createFixture()
  await page.chooseImage()
  const snapshot = page._edited.slice()
  const path = page.data.resultPath
  for (let index = 0; index < 10; index += 1) await page.changeZoom(zoomEvent(1))
  assert.equal(page.data.zoom, 8)
  assert.equal(page._previewFit.scale, 320)
  assert.equal(canvas.width, 5)
  assert.equal(canvas.height, 5)
  assert.equal(page.data.resultPath, path)
  assert.deepEqual(page._edited, snapshot)
  assert.equal(state.exports.length, 1)
  for (let index = 0; index < 10; index += 1) await page.changeZoom(zoomEvent(-1))
  assert.equal(page.data.zoom, 1)
  assert.equal(page._previewFit.scale, 40)
})

test('move drags only preview, clamps at image edges, and fit resets pan', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  const snapshot = page._edited.slice()
  const path = page.data.resultPath
  await page.changeZoom(zoomEvent(1))
  page.changeBrushTool(toolEvent('move'))
  page.onBrushStart(brushEvent(100, 100))
  assert.equal(page.data.isPanning, true)
  page.onBrushMove(brushEvent(140, 80))
  assert.equal(page._panX, 40)
  assert.equal(page._panY, -20)
  await page.changeZoom(zoomEvent(1))
  assert.equal(page.data.zoom, 2, 'transform must stay fixed during a drag')
  page.onBrushMove(brushEvent(1000, 1000))
  assert.equal(page._panX, 100)
  assert.equal(page._panY, 100)
  page.onBrushEnd()
  assert.equal(page.data.isPanning, false)
  assert.equal(page.data.strokeCount, 0)
  assert.deepEqual(page._edited, snapshot)
  assert.equal(page.data.resultPath, path)
  assert.equal(page.data.isDirty, false)
  assert.equal(state.exports.length, 1)
  await page.fitPreview()
  assert.equal(page.data.zoom, 1)
  assert.equal(page._panX, 0)
  assert.equal(page._panY, 0)
})

test('zoomed and panned brush coordinates stay correct through erase, restore and undo', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  await page.changeZoom(zoomEvent(1))
  page.changeBrushTool(toolEvent('move'))
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushMove(brushEvent(140, 80))
  page.onBrushEnd()
  page.changeBrushTool(toolEvent('erase'))
  page.onBrushStart(brushEvent(140, 80))
  page.onBrushEnd()
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 0)
  page.changeBrushTool(toolEvent('restore'))
  page.onBrushStart(brushEvent(140, 80))
  page.onBrushEnd()
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 255)
  page.undoStroke()
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 0)
  page.undoStroke()
  assert.equal(page._edited[(2 * 5 + 2) * 4 + 3], 255)
  assert.equal(page.data.zoom, 2)
})

test('picker samples edited RGB and falls back to original for transparent pixels without an edit', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  const path = page.data.resultPath
  page.changeBrushTool(toolEvent('picker'))
  page.onBrushStart(brushEvent(20, 20))
  assert.equal(page.data.brushColor, '#ffffff')
  assert.deepEqual([...page.data.brushRgb], [255, 255, 255])
  assert.equal(page.data.brushTool, 'paint')
  assert.equal(page.data.resultPath, path)
  assert.equal(page.data.isDirty, false)
  assert.equal(page.data.strokeCount, 0)
  assert.equal(page.data.isDrawing, false)
  page.changeBrushTool(toolEvent('picker'))
  page.onBrushStart(brushEvent(60, 100))
  assert.equal(page.data.brushColor, '#19412d')
  assert.equal(page.data.strokeCount, 0)
  assert.equal(state.exports.length, 1)
})

test('zoomed paint records a colour snapshot, supports undo and saves a full-size PNG', async () => {
  const { page, state } = createFixture()
  await page.chooseImage()
  page.changeBrushRadius({ detail: { value: 1 } })
  await page.changeZoom(zoomEvent(2))
  page.changeBrushTool(toolEvent('move'))
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushMove(brushEvent(160, 100))
  page.onBrushEnd()
  page.changeBrushTool(toolEvent('picker'))
  page.onBrushStart(brushEvent(40, 100))
  assert.equal(page.data.brushColor, '#19412d')
  page.onBrushStart(brushEvent(160, 100))
  page.onBrushEnd()
  const offset = (2 * 5 + 2) * 4
  assert.deepEqual([...page._edited.slice(offset, offset + 4)], [25, 65, 45, 255])
  assert.deepEqual([...page._strokes[0].color], [25, 65, 45])
  page.setData({ brushRgb: [200, 100, 50], brushColor: '#c86432' })
  await page.changeTolerance({ detail: { value: 20 } })
  assert.deepEqual([...page._edited.slice(offset, offset + 4)], [25, 65, 45, 255])
  page.undoStroke()
  assert.deepEqual([...page._edited.slice(offset, offset + 4)], [255, 255, 255, 255])
  page.changeBrushTool(toolEvent('paint'))
  page.onBrushStart(brushEvent(160, 100))
  page.onBrushEnd()
  page.setData({ brushRgb: [0, 0, 0], brushColor: '#000000' })
  page.changeBrushTool(toolEvent('picker'))
  page.onBrushStart(brushEvent(160, 100))
  assert.equal(page.data.brushColor, '#c86432', 'picker must read painted pixels rather than original RGB')
  assert.equal(page.data.strokeCount, 1)
  await page.saveImage()
  const exported = state.exports.at(-1)
  assert.equal(exported.destWidth, 5)
  assert.equal(exported.destHeight, 5)
  assert.equal(exported.data.length, 100)
  assert.equal(exported.data[3], 0)
  assert.deepEqual([...exported.data.slice(offset, offset + 4)], [200, 100, 50, 255])
  assert.deepEqual([...page._original.data.slice(offset, offset + 4)], [255, 255, 255, 255])
})

test('original comparison preserves zoom and pan while rejecting editing and transforms', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  await page.changeZoom(zoomEvent(1))
  page.changeBrushTool(toolEvent('move'))
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushMove(brushEvent(130, 90))
  page.onBrushEnd()
  page.switchPreview({ currentTarget: { dataset: { mode: 'original' } } })
  await page.changeZoom(zoomEvent(1))
  await page.fitPreview()
  page.onBrushStart(brushEvent(100, 100))
  assert.equal(page.data.isPanning, false)
  assert.equal(page.data.zoom, 2)
  assert.equal(page._panX, 30)
  assert.equal(page._panY, -10)
  page.switchPreview({ currentTarget: { dataset: { mode: 'result' } } })
  await page.drawPreview()
  assert.equal(page._previewFit.zoom, 2)
  assert.equal(page._previewFit.panX, 30)
})

test('new image and example reset transforms and hide/resize finish active drags', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  await page.changeZoom(zoomEvent(1))
  page.changeBrushTool(toolEvent('move'))
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushMove(brushEvent(120, 100))
  page.onHide()
  assert.equal(page.data.isPanning, false)
  assert.equal(page._activePan, null)
  page.onShow()
  await page.drawPreview()
  page.onBrushStart(brushEvent(100, 100))
  page.onBrushMove(brushEvent(110, 100))
  page.onResize()
  assert.equal(page.data.isPanning, false)
  await page.chooseImage()
  assert.equal(page.data.zoom, 1)
  assert.equal(page._panX, 0)
  assert.equal(page._panY, 0)
  await page.changeZoom(zoomEvent(1))
  await page.useExample()
  assert.equal(page.data.zoom, 1)
  assert.equal(page._panX, 0)
  assert.equal(page._panY, 0)
})

test('drawer and busy states lock viewport transforms and the tool selector', async () => {
  const { page } = createFixture()
  await page.chooseImage()
  for (const patch of [{ drawerOpen: true }, { isLoading: true }, { isSaving: true }]) {
    page.setData(patch)
    await page.changeZoom(zoomEvent(1))
    await page.fitPreview()
    page.changeBrushTool(toolEvent('move'))
    assert.equal(page.data.zoom, 1)
    assert.equal(page.data.brushTool, 'erase')
    page.setData({ drawerOpen: false, isLoading: false, isSaving: false })
  }
})
