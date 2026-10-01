const { GifProject, MAX_BYTES } = require('../../utils/gif-project')
const { GifEncoder } = require('../../utils/gif-encoder')
const { applyStroke } = require('../../utils/frame-editor')
const { createEditorView, viewPoint, clampZoom } = require('../../utils/editor-view')

function callWx(method, options) {
  return new Promise((resolve, reject) => wx[method]({ ...options, success: resolve, fail: reject }))
}
function fileCall(method, options) {
  return new Promise((resolve, reject) => wx.getFileSystemManager()[method]({ ...options, success: resolve, fail: reject }))
}
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 20))

Page({
  data: {
    loaded: false, busy: false, generating: false, sharing: false, playing: false, drawerOpen: false,
    frameIndex: 0, frameMax: 0, frameNumber: 1, frameCount: 0, delayMs: 0,
    previewHeight: 280, previewWidth: '100%', previewBackground: 'checker', previewMode: 'result',
    tolerance: 32, mode: 'edge', tool: 'erase', radius: 12, undoCount: 0,
    zoom: 1, brushColor: '#1c1c1e', brushRgb: [28, 28, 30], drawing: false, viewMoving: false,
    editedCount: 0, outputPath: '', imageSize: '', progress: 0,
    needsAlbumPermission: false, errorText: '', statusText: '选择 GIF，逐帧去白底并手动修整'
  },

  onHide() { this.pause(); this.cancelStroke(); this.cancelNavigation(); this.cancelGeneration() },
  onUnload() {
    this._disposed = true
    this.pause(); this.cancelGeneration(); this._stroke = null
    this._project = null; this._canvas = null; this._sourceCanvas = null; this._navigation = null
    if (!this.data.sharing) this.deleteOutput()
  },
  locked() { return this._disposed || this.data.busy || this.data.generating || this.data.sharing || this.data.drawerOpen || this.data.drawing || this.data.viewMoving },
  onDrawerChange(event) {
    if (this._disposed) return
    if (event.detail.open) { this.pause(); this.cancelStroke(); this.cancelNavigation() }
    this.setData({ drawerOpen: !!event.detail.open })
  },
  pause() {
    clearTimeout(this._timer)
    this._timer = null
    this._renderSerial = (this._renderSerial || 0) + 1
    if (!this._disposed) this.setData({ playing: false })
  },
  async canvas() {
    if (this._disposed) return null
    if (this._canvas) return this._canvas
    const node = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#gif-canvas').fields({ node: true, size: true })
        .exec(results => {
          const item = results[0]
          if (!item || !item.node) { reject(new Error('画布尚未就绪，请重试')); return }
          if (!this._disposed && this._project) {
            const width = item.width || 300
            const scale = Math.min(width / this._project.width, 400 / this._project.height)
            this._viewWidth = this._project.width * scale
            this._viewHeight = this._project.height * scale
            this._ratio = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo().pixelRatio || 1 : 1
            this.setData({ previewWidth: `${this._project.width * scale}px`, previewHeight: this._project.height * scale })
          }
          resolve(item.node)
        })
    })
    if (this._disposed) return null
    this._canvas = node
    return node
  },
  async sourceCanvas() {
    if (this._sourceCanvas) return this._sourceCanvas
    const node = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#gif-source-canvas').fields({ node: true })
        .exec(results => results[0] && results[0].node ? resolve(results[0].node) : reject(new Error('处理画布尚未就绪')))
    })
    if (this._disposed) return null
    this._sourceCanvas = node
    return node
  },
  async onResize() {
    if (this._disposed || !this._project || this.locked()) return
    this.pause(); this.cancelStroke(); this.cancelNavigation()
    this._canvas = null
    this.setData({ previewWidth: '100%', busy: true })
    try {
      await yieldFrame()
      if (!this._disposed) await this.showFrame(this.data.frameIndex)
    } catch (error) { this.showError(error) }
    finally { if (!this._disposed) this.setData({ busy: false }) }
  },
  changeZoom(event) {
    if (this.locked() || !this._project || this.data.previewMode !== 'result') return
    const delta = Number(event.currentTarget.dataset.delta)
    if (!Number.isFinite(delta)) return
    this.pause()
    this.setData({ zoom: clampZoom(this.data.zoom + delta) })
    this.paint()
  },
  resetView() {
    if (this.locked() || !this._project) return
    this.pause()
    this._panX = 0; this._panY = 0
    this.setData({ zoom: 1 })
    this.paint()
  },
  deleteOutput() {
    const path = this._output
    this._output = ''
    if (path) wx.getFileSystemManager().unlink({ filePath: path, fail() {} })
  },
  invalidate() {
    this.deleteOutput()
    this.setData({ outputPath: '', progress: 0 })
  },
  async chooseGif() {
    if (this.locked()) return
    this.pause(); this.cancelStroke()
    this.setData({ busy: true, errorText: '' })
    try {
      const selected = await callWx('chooseMessageFile', { count: 1, type: 'all' })
      if (this._disposed) return
      const file = selected.tempFiles && selected.tempFiles[0]
      if (!file || !file.path) throw new Error('没有选到 GIF 文件')
      const info = await fileCall('stat', { path: file.path })
      if (this._disposed) return
      if (info.stats.size > MAX_BYTES || file.size > MAX_BYTES) throw new Error('请选择不超过 8 MB 的 GIF')
      const result = await fileCall('readFile', { filePath: file.path })
      if (this._disposed) return
      await this.loadBytes(result.data)
    } catch (error) { if (!/cancel/i.test(error.errMsg || error.message || '')) this.showError(error) }
    finally { if (!this._disposed) this.setData({ busy: false }) }
  },
  async useExample() {
    if (this.locked()) return
    this.pause(); this.cancelStroke()
    this.setData({ busy: true, errorText: '' })
    try {
      const encoder = new GifEncoder(96, 72, { loopCount: 0 })
      for (let f = 0; f < 6; f++) {
        const pixels = new Uint8ClampedArray(96 * 72 * 4).fill(255)
        for (let y = 22; y < 50; y++) for (let x = 10 + f * 9; x < 36 + f * 9; x++) {
          pixels.set([231, 142, 102, 255], (y * 96 + x) * 4)
        }
        encoder.addFrame(pixels, 12 + f * 2)
      }
      await this.loadBytes(encoder.finish())
    } catch (error) { this.showError(error) }
    finally { if (!this._disposed) this.setData({ busy: false }) }
  },
  async loadBytes(bytes) {
    const project = new GifProject(bytes)
    project.render(0)
    if (this._disposed) return
    this.invalidate()
    this._project = project
    this._canvas = null
    this._panX = 0; this._panY = 0
    this.setData({
      loaded: true, frameIndex: 0, frameNumber: 1, frameMax: project.gif.frameCount - 1,
      frameCount: project.gif.frameCount, tolerance: 32, mode: 'edge',
      previewMode: 'result', editedCount: 0, undoCount: 0,
      zoom: 1, tool: 'erase', brushColor: '#1c1c1e', brushRgb: [28, 28, 30],
      previewWidth: '100%', previewHeight: 280,
      imageSize: `${project.width} × ${project.height} · ${project.gif.frameCount} 帧`,
      statusText: '已自动去白底，暂停时可涂抹当前帧'
    })
    // Wait for the conditional canvas to be mounted after setData.
    await yieldFrame()
    if (!this._disposed) await this.showFrame(0)
  },
  async showFrame(index) {
    if (!this._project || this._disposed) return
    const project = this._project
    const serial = this._renderSerial = (this._renderSerial || 0) + 1
    const canvas = await this.canvas()
    if (!canvas || this._disposed) return
    const source = await this.sourceCanvas()
    if (!canvas || !source || this._disposed || project !== this._project || serial !== this._renderSerial) return
    project.validateIndex(index)
    this._pixels = this.data.previewMode === 'original' ? new Uint8ClampedArray(project.original(index)) : project.render(index)
    canvas.width = Math.round(this._viewWidth * this._ratio)
    canvas.height = Math.round(this._viewHeight * this._ratio)
    this.paint()
    this.setData({ frameIndex: index, frameNumber: index + 1,
      delayMs: project.gif.frames[index].delay * 10, undoCount: project.strokes[index].length })
  },
  paint() {
    if (!this._canvas || !this._sourceCanvas || !this._project || !this._pixels) return
    const source = this._sourceCanvas
    source.width = this._project.width; source.height = this._project.height
    const sourceContext = source.getContext('2d')
    const image = sourceContext.createImageData(this._project.width, this._project.height)
    image.data.set(this._pixels)
    sourceContext.putImageData(image, 0, 0)
    const view = this._view = createEditorView(this._project.width, this._project.height, this._viewWidth, this._viewHeight,
      this.data.previewMode === 'original' ? {} : { zoom: this.data.zoom, panX: this._panX, panY: this._panY })
    if (this.data.previewMode === 'result') { this._panX = view.panX; this._panY = view.panY }
    const ctx = this._canvas.getContext('2d')
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
    ctx.imageSmoothingEnabled = view.zoom < 3
    ctx.drawImage(source, view.x * this._ratio, view.y * this._ratio, view.width * this._ratio, view.height * this._ratio)
  },
  async seek(index) {
    if (this.locked() || !this._project) return
    this.pause(); this.cancelStroke()
    this.setData({ busy: true })
    try { await this.showFrame(Math.max(0, Math.min(this.data.frameMax, index))) }
    catch (error) { this.showError(error) }
    finally { if (!this._disposed) this.setData({ busy: false }) }
  },
  changeFrame(event) { return this.seek(Number(event.detail.value)) },
  previousFrame() { return this.seek(this.data.frameIndex - 1) },
  nextFrame() { return this.seek(this.data.frameIndex + 1) },
  async togglePlay() {
    if (this.data.playing) { this.pause(); return }
    if (this.locked() || !this._project) return
    this.cancelStroke()
    this.setData({ playing: true })
    const tick = async () => {
      if (!this.data.playing || this._disposed) return
      try {
        await this.showFrame((this.data.frameIndex + 1) % this.data.frameCount)
        if (this.data.playing && !this._disposed) this._timer = setTimeout(tick, this.data.delayMs || 100)
      } catch (error) { this.pause(); this.showError(error) }
    }
    this._timer = setTimeout(tick, this.data.delayMs || 100)
  },
  async reprocess(patch) {
    if (this.locked()) return
    this.pause(); this.cancelStroke()
    this.setData(patch)
    if (!this._project) return
    this._project.settings = { ...this._project.settings, tolerance: this.data.tolerance, mode: this.data.mode }
    this.invalidate()
    await this.seek(this.data.frameIndex)
  },
  changeTolerance(event) { return this.reprocess({ tolerance: Number(event.detail.value) }) },
  changeMode(event) { return this.reprocess({ mode: event.detail.value ? 'all' : 'edge' }) },
  async switchPreview(event) {
    if (this.locked()) return
    this.pause(); this.cancelStroke()
    this.setData({ previewMode: event.currentTarget.dataset.mode })
    await this.seek(this.data.frameIndex)
  },
  switchBackground(event) { this.setData({ previewBackground: event.currentTarget.dataset.background }) },
  setTool(event) {
    if (this.locked()) return
    this.pause(); this.cancelStroke()
    const tool = event.currentTarget.dataset.tool
    if (['erase', 'restore', 'paint', 'picker', 'move'].includes(tool)) this.setData({ tool })
  },
  changeRadius(event) {
    if (this.locked()) return
    this.cancelStroke()
    this.setData({ radius: Number(event.detail.value) })
  },
  localPoint(touch, rect) {
    return {
      x: Number.isFinite(touch.clientX) ? touch.clientX - rect.left : touch.x,
      y: Number.isFinite(touch.clientY) ? touch.clientY - rect.top : touch.y
    }
  },
  startNavigation(touch) {
    const navigation = this._navigation = { tool: this.data.tool, first: touch, latest: touch,
      startX: this._panX || 0, startY: this._panY || 0, ended: false, rect: null }
    this.setData({ viewMoving: true })
    wx.createSelectorQuery().in(this).select('#gif-canvas').boundingClientRect(rect => {
      if (this._navigation !== navigation || this._disposed) return
      if (!rect || !rect.width || !rect.height) { this.cancelNavigation(); return }
      navigation.rect = rect
      const first = this.localPoint(navigation.first, rect)
      if (!Number.isFinite(first.x) || !Number.isFinite(first.y)) { this.cancelNavigation(); return }
      navigation.startPoint = first
      if (navigation.tool === 'picker') {
        const view = createEditorView(this._project.width, this._project.height, rect.width, rect.height,
          { zoom: this.data.zoom, panX: this._panX, panY: this._panY })
        const point = viewPoint(view, first)
        const x = Math.floor(point.x); const y = Math.floor(point.y)
        if (x >= 0 && y >= 0 && x < this._project.width && y < this._project.height) {
          const offset = (y * this._project.width + x) * 4
          const pixels = this._pixels[offset + 3] ? this._pixels : this._project.original(this.data.frameIndex)
          if (pixels[offset + 3]) {
            const color = Array.from(pixels.slice(offset, offset + 3))
            this.setData({ brushRgb: color, brushColor: '#' + color.map(c => c.toString(16).padStart(2, '0')).join(''), tool: 'paint' })
          }
        }
        this.cancelNavigation()
      } else {
        this.panNavigation(navigation.latest)
        if (navigation.ended) this.cancelNavigation()
      }
    }).exec()
  },
  panNavigation(touch) {
    const navigation = this._navigation
    if (!navigation || !navigation.rect || navigation.tool !== 'move') return
    const point = this.localPoint(touch, navigation.rect)
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    const view = createEditorView(this._project.width, this._project.height, navigation.rect.width, navigation.rect.height,
      { zoom: this.data.zoom, panX: navigation.startX + point.x - navigation.startPoint.x,
        panY: navigation.startY + point.y - navigation.startPoint.y })
    this._panX = view.panX; this._panY = view.panY
    this.paint()
  },
  moveNavigation(event) {
    const touch = event.touches && event.touches[0]
    if (!touch || !this._navigation) return
    this._navigation.latest = touch
    this.panNavigation(touch)
  },
  endNavigation(event) {
    const navigation = this._navigation
    if (!navigation) return
    const touch = event.changedTouches && event.changedTouches[0]
    if (touch) navigation.latest = touch
    if (!navigation.rect) { navigation.ended = true; return }
    this.panNavigation(navigation.latest)
    this.cancelNavigation()
  },
  cancelNavigation() {
    this._navigation = null
    if (!this._disposed && this.data.viewMoving) this.setData({ viewMoving: false })
  },
  touchStart(event) {
    if (event.touches && event.touches.length > 1) { this.touchCancel(); return }
    if (this.locked() || !this._project || this.data.previewMode !== 'result') return
    if (event.touches && event.touches.length !== 1) return
    this.pause(); this.cancelStroke()
    const point = event.touches && event.touches[0]
    if (!point) return
    if (this.data.tool === 'move' || this.data.tool === 'picker') { this.startNavigation(point); return }
    const pending = this._stroke = { index: this.data.frameIndex, tool: this.data.tool,
      identifier: point.identifier, radius: this.data.radius, color: this.data.brushRgb.slice(), points: [], pending: [point], rect: null, ended: false }
    this.setData({ drawing: true })
    wx.createSelectorQuery().in(this).select('#gif-canvas').boundingClientRect(rect => {
      if (this._stroke !== pending || this._disposed) return
      if (!rect || !rect.width || !rect.height) { this.cancelStroke(); return }
      pending.rect = rect
      pending.view = createEditorView(this._project.width, this._project.height, rect.width, rect.height,
        { zoom: this.data.zoom, panX: this._panX, panY: this._panY })
      for (const touch of pending.pending) this.appendPoint(touch)
      pending.pending = []
      if (pending.ended) this.commitStroke()
    }).exec()
  },
  appendPoint(touch) {
    const stroke = this._stroke
    if (!stroke || !stroke.rect || stroke.points.length >= 1024) return
    const rect = stroke.rect
    const localX = Number.isFinite(touch.clientX) ? touch.clientX - rect.left : touch.x
    const localY = Number.isFinite(touch.clientY) ? touch.clientY - rect.top : touch.y
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) return
    const point = viewPoint(stroke.view, { x: localX, y: localY })
    if (!stroke.points.length && (point.x < 0 || point.y < 0 || point.x >= this._project.width || point.y >= this._project.height)) return
    const previous = stroke.points[stroke.points.length - 1]
    stroke.points.push(point)
    applyStroke(this._pixels, this._project.original(stroke.index), this._project.width, this._project.height,
      { tool: stroke.tool, radius: stroke.radius, color: stroke.color, points: previous ? [previous, point] : [point] })
    this.invalidate()
    this.paint()
  },
  touchMove(event) {
    if (event.touches && event.touches.length > 1) { this.cancelStroke(); this.cancelNavigation(); return }
    const active = this._stroke || this._navigation
    const touch = event.touches && event.touches[0]
    const identifier = active && (active.first ? active.first.identifier : active.identifier)
    if (touch && identifier !== undefined && touch.identifier !== undefined && touch.identifier !== identifier) { this.touchCancel(); return }
    if (this._navigation) { this.moveNavigation(event); return }
    const stroke = this._stroke
    const point = event.touches && event.touches[0]
    if (!stroke || !point) return
    if (stroke.rect) this.appendPoint(point)
    else if (stroke.pending.length < 1024) stroke.pending.push(point)
  },
  touchEnd(event) {
    if (event.touches && event.touches.length) { this.touchCancel(); return }
    const active = this._stroke || this._navigation
    const touch = event.changedTouches && event.changedTouches[0]
    const identifier = active && (active.first ? active.first.identifier : active.identifier)
    if (touch && identifier !== undefined && touch.identifier !== undefined && touch.identifier !== identifier) { this.touchCancel(); return }
    if (this._navigation) { this.endNavigation(event); return }
    if (!this._stroke) return
    const point = event.changedTouches && event.changedTouches[0]
    if (point) {
      if (this._stroke.rect) this.appendPoint(point)
      else if (this._stroke.pending.length < 1024) this._stroke.pending.push(point)
    }
    if (!this._stroke.rect) { this._stroke.ended = true; return }
    this.commitStroke()
  },
  touchCancel() { this.cancelStroke(); this.cancelNavigation() },
  commitStroke() {
    const stroke = this._stroke
    this._stroke = null
    if (!this._disposed) this.setData({ drawing: false })
    if (!stroke || !stroke.points.length) return
    try {
      this._project.addStroke(stroke.index, stroke)
      this.setData({ undoCount: this._project.strokes[stroke.index].length, editedCount: this._project.editedCount })
    } catch (error) {
      this._pixels = this._project.render(stroke.index); this.paint(); this.showError(error)
    }
  },
  cancelStroke() {
    if (!this._stroke) return
    const index = this._stroke.index
    this._stroke = null
    if (!this._disposed) this.setData({ drawing: false })
    if (this._project && !this._disposed) { this._pixels = this._project.render(index); this.paint() }
  },
  async undo() {
    if (this.locked() || !this._project) return
    this.pause(); this.cancelStroke()
    this._project.undo(this.data.frameIndex)
    this.invalidate()
    this.setData({ editedCount: this._project.editedCount })
    await this.seek(this.data.frameIndex)
  },
  cancelGeneration() { this._generation = (this._generation || 0) + 1 },
  async generate() {
    if (this.locked() || !this._project) return
    this.pause()
    if (this._stroke && this._stroke.rect) this.commitStroke()
    else this.cancelStroke()
    this.invalidate()
    const token = this._generation = (this._generation || 0) + 1
    const cancelled = () => this._disposed || token !== this._generation
    this.setData({ generating: true, progress: 0, errorText: '', statusText: '正在逐帧生成透明 GIF…' })
    let path = ''
    try {
      const bytes = await this._project.encode({ cancelled, yieldFrame,
        progress: (done, total) => { if (!cancelled()) this.setData({ progress: Math.round(done * 100 / total) }) } })
      if (cancelled()) return
      path = `${wx.env.USER_DATA_PATH}/cutout-${Date.now()}-${token}.gif`
      await fileCall('writeFile', { filePath: path, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
      if (cancelled()) {
        wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); return
      }
      this._output = path
      this.setData({ outputPath: path, statusText: '生成完成，发送 GIF 文件可保留原动画', progress: 100 })
    } catch (error) {
      if (path) wx.getFileSystemManager().unlink({ filePath: path, fail() {} })
      if (!this._disposed) {
        if (cancelled()) this.setData({ statusText: '已取消生成，编辑记录保留' })
        else this.showError(error)
      }
    } finally {
      if (!this._disposed) this.setData({ generating: false, ...(cancelled() ? { statusText: '已取消生成，编辑记录保留' } : {}) })
    }
  },
  async shareGif() {
    if (this.locked() || !this.data.outputPath) return
    if (typeof wx.shareFileMessage !== 'function') { this.showError(new Error('当前微信版本不支持发送文件，请升级微信')); return }
    this.setData({ sharing: true })
    try { await callWx('shareFileMessage', { filePath: this.data.outputPath, fileName: '去白底.gif' }) }
    catch (error) { if (!/cancel/i.test(error.errMsg || error.message || '')) this.showError(error) }
    finally { if (!this._disposed) this.setData({ sharing: false }); else this.deleteOutput() }
  },
  async saveGif() {
    if (this.locked() || !this.data.outputPath) return
    this.setData({ sharing: true, errorText: '' })
    try {
      await callWx('saveImageToPhotosAlbum', { filePath: this.data.outputPath })
      if (!this._disposed) {
        this.setData({ needsAlbumPermission: false })
        wx.showToast({ title: '已保存，请检查动画', icon: 'none' })
      }
    } catch (error) {
      if (/auth|permission|denied/i.test(error.errMsg || error.message || '')) {
        if (!this._disposed) this.setData({ needsAlbumPermission: true, errorText: '请开启相册权限后再次保存' })
      } else this.showError(error)
    } finally { if (!this._disposed) this.setData({ sharing: false }); else this.deleteOutput() }
  },
  onAlbumSetting(event) {
    if (event.detail.authSetting && event.detail.authSetting['scope.writePhotosAlbum']) this.setData({ needsAlbumPermission: false, errorText: '' })
  },
  showError(error) {
    if (!this._disposed) this.setData({ errorText: error.message || error.errMsg || '处理失败，请重试', statusText: '操作未完成，编辑记录仍保留' })
  }
})
