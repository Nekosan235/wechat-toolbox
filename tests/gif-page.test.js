const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { GifEncoder } = require('../utils/gif-encoder')
const { parseGif, composeGifFrames } = require('../utils/gif-decoder')

const pagePath = path.join(__dirname, '../pages/gif/index.js')
function bytes() {
  const encoder = new GifEncoder(5, 5, { loopCount: 3 })
  for (const delay of [7, 18]) {
    const pixels = new Uint8ClampedArray(100).fill(255)
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) pixels.set([40, 60, 30, 255], (y * 5 + x) * 4)
    pixels.set([255, 255, 255, 255], 48)
    encoder.addFrame(pixels, delay)
  }
  return encoder.finish()
}
function fixture() {
  const state = { writes: [], unlinks: [], shares: [], saves: [], updates: 0, rect: { left: 20, top: 40, width: 300, height: 300 } }
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) } },
    putImageData(image) { state.pixels = new Uint8ClampedArray(image.data) }
  }
  const canvas = { getContext: () => context }
  const previewCanvas = { getContext: () => ({ clearRect() {}, drawImage(...args) { state.previewDraw = args } }) }
  const file = {
    stat(r) { r.success({ stats: { size: state.size || bytes().length } }) },
    readFile(r) { state.reads = (state.reads || 0) + 1; r.success({ data: bytes().buffer }) },
    writeFile(r) {
      state.writes.push(r)
      if (state.deferWrite) state.pendingWrite = r
      else if (state.writeFail) r.fail({ errMsg: 'writeFile:fail storage' })
      else r.success({})
    },
    unlink(r) { state.unlinks.push(r.filePath) }
  }
  const wx = {
    env: { USER_DATA_PATH: 'wxfile://user' }, getFileSystemManager: () => file,
    createSelectorQuery() {
      let callback
      return {
        in() { return this }, select(selector) { this.selector = selector; return this }, fields() { return this },
        boundingClientRect(cb) { callback = cb; return this },
        exec(cb) {
          if (callback) {
            if (state.deferRect) state.pendingRect = () => callback(state.rect)
            else callback(state.rect)
          } else cb([{ node: this.selector === '#gif-source-canvas' ? canvas : previewCanvas, width: 300, height: 280 }])
        }
      }
    },
    chooseMessageFile(r) {
      if (state.cancelSelect) r.fail({ errMsg: 'chooseMessageFile:fail cancel' })
      else r.success({ tempFiles: [{ path: 'mock://input.gif', size: state.size || bytes().length }] })
    },
    shareFileMessage(r) { state.shares.push(r); r.success({}) },
    saveImageToPhotosAlbum(r) {
      state.saves.push(r.filePath)
      if (state.denySave) r.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' })
      else r.success({})
    },
    showToast() {}
  }
  let definition
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    Page(value) { definition = value }, wx, require: createRequire(pagePath),
    Uint8ClampedArray, setTimeout, clearTimeout, Date, Number, console
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { state.updates++; Object.assign(this.data, patch) } }
  return { page, state, wx }
}
function stroke(page, x = 150, y = 150) {
  page.data.radius = 1
  page.touchStart({ touches: [{ x, y }] })
  page.touchEnd({ changedTouches: [{ x, y }] })
}

test('choose GIF -> seek -> edit -> generate -> file share preserves timing and loop', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  assert.equal(page.data.frameCount, 2)
  assert.equal(page.data.delayMs, 70)
  assert.equal(page.data.previewWidth, '300px')
  assert.equal(page.data.previewHeight, 300)
  assert.equal(state.pixels[3], 0)
  stroke(page)
  await page.nextFrame()
  assert.equal(page.data.undoCount, 0)
  assert.equal(page.data.delayMs, 180)
  await page.generate()
  const gif = parseGif(state.writes[0].data)
  const frames = [...composeGifFrames(gif)]
  assert.equal(gif.loopCount, 3)
  assert.deepEqual(gif.frames.map(f => f.delay), [7, 18])
  assert.equal(frames[0].data[12 * 4 + 3], 0)
  assert.equal(frames[1].data[12 * 4 + 3], 255)
  await page.shareGif()
  assert.equal(state.shares[0].filePath, page.data.outputPath)
  assert.equal(state.shares[0].fileName, '去白底.gif')
  page.onUnload()
})

test('erase invalidates an old export; restore and per-frame undo use original pixels', async () => {
  const { page, state } = fixture()
  await page.chooseGif(); await page.generate()
  const old = page.data.outputPath
  stroke(page)
  assert.equal(page.data.outputPath, '')
  assert.ok(state.unlinks.includes(old))
  assert.equal(page.data.editedCount, 1)
  await page.nextFrame(); await page.undo()
  await page.previousFrame()
  assert.equal(page.data.undoCount, 1)
  assert.equal(state.pixels[51], 0)
  await page.undo()
  assert.equal(state.pixels[51], 255)
  page.setTool({ currentTarget: { dataset: { tool: 'restore' } } })
  stroke(page, 30, 30)
  assert.equal(state.pixels[3], 255)
  await page.changeMode({ detail: { value: true } })
  assert.equal(state.pixels[3], 255, 'automatic settings replay manual restore')
  page.onUnload()
})

test('touch end before rectangle lookup completes still commits one complete stroke', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.deferRect = true
  stroke(page)
  assert.equal(page.data.undoCount, 0)
  state.pendingRect()
  assert.equal(page.data.undoCount, 1)
  assert.equal(state.pixels[51], 0)
  page.onUnload()
})

test('touch uses current client rectangle; cancelled strokes and original preview never persist', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  page.data.radius = 1
  state.rect.top = 140
  page.touchStart({ touches: [{ clientX: 170, clientY: 290 }] })
  page.touchEnd({})
  assert.equal(state.pixels[51], 0)
  await page.undo()
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.cancelStroke()
  assert.equal(page.data.undoCount, 0)
  assert.equal(state.pixels[51], 255)
  await page.switchPreview({ currentTarget: { dataset: { mode: 'original' } } })
  stroke(page)
  assert.equal(page.data.undoCount, 0)
  page.onUnload()
})

test('oversized files are rejected before read and cancelled selection retains the current project', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  const project = page._project
  state.cancelSelect = true
  await page.chooseGif()
  assert.equal(page._project, project)
  state.cancelSelect = false; state.size = 9 * 1024 * 1024
  await page.chooseGif()
  assert.equal(state.reads, 1)
  assert.match(page.data.errorText, /8 MB/)
  page.onUnload()
})

test('generation cancel stops before writing and preserves editing records', async () => {
  const { page, state } = fixture()
  await page.chooseGif(); stroke(page)
  const promise = page.generate()
  page.cancelGeneration()
  await promise
  assert.equal(page.data.generating, false)
  assert.equal(page.data.outputPath, '')
  assert.equal(state.writes.length, 0)
  assert.equal(page.data.undoCount, 1)
  assert.match(page.data.statusText, /已取消/)
  page.onUnload()
})

test('unload during an asynchronous file write removes only the generated file and makes no late UI updates', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.deferWrite = true
  const promise = page.generate()
  while (!state.pendingWrite) await new Promise(resolve => setTimeout(resolve, 10))
  page.onUnload()
  const updates = state.updates
  state.pendingWrite.success({})
  await promise
  assert.equal(state.updates, updates)
  assert.deepEqual(state.unlinks, [state.pendingWrite.filePath])
})

test('album denial exposes recovery and missing share API reports a readable error', async () => {
  const { page, state, wx } = fixture()
  await page.chooseGif(); await page.generate()
  state.denySave = true
  await page.saveGif()
  assert.equal(page.data.needsAlbumPermission, true)
  page.onAlbumSetting({ detail: { authSetting: { 'scope.writePhotosAlbum': true } } })
  assert.equal(page.data.needsAlbumPermission, false)
  delete wx.shareFileMessage
  await page.shareGif()
  assert.match(page.data.errorText, /升级微信/)
  page.onUnload()
})

test('background swatches are display-only and busy controls cannot edit or export stale results', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  const pixels = new Uint8ClampedArray(state.pixels)
  page.switchBackground({ currentTarget: { dataset: { background: 'dark' } } })
  assert.deepEqual(state.pixels, pixels)
  page.data.generating = true
  stroke(page); await page.undo(); await page.nextFrame(); await page.shareGif()
  assert.equal(page.data.undoCount, 0)
  assert.equal(page.data.frameIndex, 0)
  assert.equal(state.shares.length, 0)
  page.data.generating = false
  page.onUnload()
})

test('file write failure cannot leave a saveable output', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.writeFail = true
  await page.generate()
  assert.equal(page.data.outputPath, '')
  assert.match(page.data.errorText, /storage/)
  assert.equal(state.unlinks.length, 1)
  page.onUnload()
})

test('a GIF with malformed first-frame LZW cannot replace the current project or export', async () => {
  const { page } = fixture()
  await page.chooseGif(); await page.generate()
  const oldProject = page._project
  const oldPath = page.data.outputPath
  const input = bytes()
  const compressed = parseGif(input).frames[0].compressed
  // Locate the first image descriptor, skip its local palette and code size,
  // then replace the first sub-block byte with an invalid initial LZW code.
  let position = 13
  if (input[10] & 128) position += 3 * (1 << ((input[10] & 7) + 1))
  while (input[position] !== 0x2c) {
    assert.equal(input[position++], 0x21)
    position++
    while (input[position]) position += input[position] + 1
    position++
  }
  const flags = input[position + 9]
  position += 10
  if (flags & 128) position += 3 * (1 << ((flags & 7) + 1))
  position += 2
  assert.equal(input[position], compressed[0])
  input[position] = 0
  await assert.rejects(page.loadBytes(input), /LZW/)
  assert.equal(page._project, oldProject)
  assert.equal(page.data.outputPath, oldPath)
  page.onUnload()
})

test('opening the drawer pauses animation and blocks underlying editor touches', async () => {
  const { page } = fixture()
  await page.chooseGif()
  await page.togglePlay()
  assert.equal(page.data.playing, true)
  page.onDrawerChange({ detail: { open: true } })
  assert.equal(page.data.playing, false)
  stroke(page)
  assert.equal(page.data.undoCount, 0)
  await page.generate()
  assert.equal(page.data.outputPath, '')
  page.onDrawerChange({ detail: { open: false } })
  stroke(page)
  assert.equal(page.data.undoCount, 1)
  page.onUnload()
})

test('zoom and movement affect preview only, and erase still targets original image coordinates', async () => {
  const { page, state } = fixture()
  await page.chooseGif(); await page.generate()
  const path = page.data.outputPath
  const originalPixels = new Uint8ClampedArray(state.pixels)
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } })
  assert.equal(page.data.zoom, 2)
  assert.equal(state.previewDraw[3], 600)
  page.setTool({ currentTarget: { dataset: { tool: 'move' } } })
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.touchMove({ touches: [{ x: 90, y: 150 }] })
  page.touchEnd({ changedTouches: [{ x: 90, y: 150 }] })
  assert.equal(page._panX, -60)
  assert.deepEqual(state.pixels, originalPixels)
  assert.equal(page.data.outputPath, path)
  assert.equal(page.data.undoCount, 0)
  page.setTool({ currentTarget: { dataset: { tool: 'erase' } } })
  stroke(page, 90, 150)
  assert.equal(state.pixels[51], 0)
  assert.equal(page._project.strokes[0][0].points[0].x, 2.5)
  await page.undo()
  assert.equal(state.pixels[51], 255)
  page.resetView()
  assert.equal(page.data.zoom, 1)
  assert.equal(page._panX, 0)
  page.onUnload()
})

test('sample then paint at zoom and pan covers without transparency; undo and GIF export preserve frame scope', async () => {
  const { page, state } = fixture()
  await page.chooseGif(); await page.generate()
  const oldPath = page.data.outputPath
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } })
  page.setTool({ currentTarget: { dataset: { tool: 'move' } } })
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.touchEnd({ changedTouches: [{ x: 90, y: 150 }] })
  page.setTool({ currentTarget: { dataset: { tool: 'picker' } } })
  stroke(page, 210, 150)
  assert.equal(page.data.tool, 'paint')
  assert.equal(page.data.brushColor, '#283c1e')
  assert.equal(page.data.undoCount, 0)
  assert.equal(page.data.outputPath, oldPath)
  stroke(page, 90, 150)
  assert.deepEqual([...state.pixels.slice(48, 52)], [40, 60, 30, 255])
  assert.equal(page.data.outputPath, '')
  page.data.brushRgb[0] = 200
  assert.deepEqual([...page._project.strokes[0][0].color], [40, 60, 30])
  await page.generate()
  const gif = parseGif(state.writes.at(-1).data)
  const frames = [...composeGifFrames(gif)]
  assert.equal(gif.width, 5)
  assert.equal(gif.height, 5)
  assert.deepEqual(gif.frames.map(f => f.delay), [7, 18])
  assert.deepEqual([...frames[0].data.slice(48, 52)], [40, 60, 30, 255])
  assert.deepEqual([...frames[1].data.slice(48, 52)], [255, 255, 255, 255])
  await page.undo()
  assert.deepEqual([...state.pixels.slice(48, 52)], [255, 255, 255, 255])
  page.onUnload()
})

test('delayed pan rectangle applies the final movement, clamps bounds and never commits a stroke', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  page.changeZoom({ currentTarget: { dataset: { delta: 10 } } })
  assert.equal(page.data.zoom, 8)
  page.setTool({ currentTarget: { dataset: { tool: 'move' } } })
  state.deferRect = true
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.touchEnd({ changedTouches: [{ x: 9999, y: -9999 }] })
  assert.equal(page.data.viewMoving, true)
  state.pendingRect()
  assert.equal(page.data.viewMoving, false)
  assert.equal(page._panX, 1050)
  assert.equal(page._panY, -1050)
  assert.equal(page.data.undoCount, 0)
  page.resetView()
  page.onUnload()
})

test('zoom cannot alter an in-flight stroke and cancelled async sampling never updates an unloaded page', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.deferRect = true
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } })
  assert.equal(page.data.zoom, 1)
  page.cancelStroke()
  page.setTool({ currentTarget: { dataset: { tool: 'picker' } } })
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  page.onUnload()
  const updates = state.updates
  state.pendingRect()
  assert.equal(state.updates, updates)
})

test('loading a new GIF resets precision view and brush selection', async () => {
  const { page } = fixture()
  await page.chooseGif()
  page.changeZoom({ currentTarget: { dataset: { delta: 5 } } })
  page._panX = 100
  page.setTool({ currentTarget: { dataset: { tool: 'paint' } } })
  await page.chooseGif()
  assert.equal(page.data.zoom, 1)
  assert.equal(page._panX, 0)
  assert.equal(page.data.tool, 'erase')
  page.onUnload()
})

test('cancelled navigation unlocks the editor, even when rectangle lookup has not returned', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.deferRect = true
  page.setTool({ currentTarget: { dataset: { tool: 'move' } } })
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  assert.equal(page.data.viewMoving, true)
  page.touchCancel()
  assert.equal(page.data.viewMoving, false)
  state.pendingRect()
  assert.equal(page._navigation, null)
  assert.equal(page.data.undoCount, 0)
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } })
  assert.equal(page.data.zoom, 2)
  page.onUnload()
})

test('a second finger cancels drawing before locks and cannot add an unrelated endpoint', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  const original = new Uint8ClampedArray(state.pixels)
  const first = { identifier: 1, x: 90, y: 90 }
  const second = { identifier: 2, x: 210, y: 210 }
  page.data.radius = 1
  page.touchStart({ touches: [first] })
  page.touchStart({ touches: [first, second] })
  page.touchEnd({ touches: [first], changedTouches: [second] })
  assert.equal(page.data.drawing, false)
  assert.equal(page.data.undoCount, 0)
  assert.deepEqual(state.pixels, original)
  page.touchStart({ touches: [first] })
  page.touchEnd({ touches: [], changedTouches: [second] })
  assert.equal(page.data.undoCount, 0, 'a mismatched touch identity cannot commit')
  assert.deepEqual(state.pixels, original)
  page.onUnload()
})

test('multi-touch cancels pending navigation and a late rectangle callback cannot resume it', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  page.changeZoom({ currentTarget: { dataset: { delta: 1 } } })
  page.setTool({ currentTarget: { dataset: { tool: 'move' } } })
  state.deferRect = true
  const first = { identifier: 1, x: 150, y: 150 }
  const second = { identifier: 2, x: 90, y: 150 }
  page.touchStart({ touches: [first] })
  page.touchStart({ touches: [first, second] })
  page.touchEnd({ touches: [first], changedTouches: [second] })
  state.pendingRect()
  assert.equal(page.data.viewMoving, false)
  assert.equal(page._navigation, null)
  assert.equal(page._panX, 0)
  page.onUnload()
})

test('resizing locks touches until a fresh preview canvas is rendered', async () => {
  const { page, state } = fixture()
  await page.chooseGif()
  state.previewDraw = null
  const resizing = page.onResize()
  assert.equal(page.data.busy, true)
  page.touchStart({ touches: [{ x: 150, y: 150 }] })
  assert.equal(page.data.drawing, false)
  await resizing
  assert.equal(page.data.busy, false)
  assert.ok(page._canvas)
  assert.ok(state.previewDraw)
  stroke(page)
  assert.equal(page.data.undoCount, 1)
  page.onUnload()
})
