const { removeWhiteBackground } = require('../../utils/remove-white')
const { applyStroke, renderEditedFrame } = require('../../utils/frame-editor')
const { createEditorView, viewPoint, clampZoom } = require('../../utils/editor-view')

const MAX_BYTES = 10 * 1024 * 1024
const MAX_EDGE = 2048

function callWx(method, options = {}) {
  return new Promise((resolve, reject) => {
    wx[method]({ ...options, success: resolve, fail: reject })
  })
}

function nextFrame() {
  return new Promise(resolve => setTimeout(resolve, 30))
}

Page({
  data: {
    originalPath: '',
    resultPath: '',
    previewMode: 'result',
    previewBackground: 'checker',
    tolerance: 32,
    mode: 'edge',
    isLoading: false,
    isSaving: false,
    statusText: '选择一张白底图片，开始制作透明素材',
    imageSize: '',
    removedPercent: '',
    wasResized: false,
    needsAlbumPermission: false,
    errorText: '',
    brushTool: 'erase',
    brushRadius: 12,
    strokeCount: 0,
    isDrawing: false,
    isDirty: false,
    hasEditable: false,
    drawerOpen: false,
    zoom: 1,
    isPanning: false,
    brushColor: '#1c1c1e',
    brushRgb: [28, 28, 30]
  },

  onUnload() {
    this._disposed = true
    this._original = null
    this._canvas = null
    this._previewCanvas = null
    this._base = null
    this._edited = null
    this._output = null
    this._strokes = []
    this._activeStroke = null
    this._activePan = null
    clearTimeout(this._drawTimer)
    clearTimeout(this._previewTimer)
  },

  onHide() {
    this._hidden = true
    this.onBrushEnd()
    clearTimeout(this._drawTimer)
    this._drawTimer = null
    clearTimeout(this._previewTimer)
    this._previewTimer = null
  },

  onShow() {
    this._hidden = false
    if (this._edited) nextFrame().then(() => this.drawPreview()).catch(error => this.showError(error))
  },

  onPageScroll(event) {
    this._scrollTop = event.scrollTop
  },

  onDrawerChange(event) {
    if (this._disposed) return
    if (event.detail.open) this.onBrushEnd()
    this.setData({ drawerOpen: !!event.detail.open })
  },

  onResize() {
    this.onBrushEnd()
    this._previewCanvas = null
    this._previewRect = null
    this._previewFit = null
    nextFrame().then(() => this.drawPreview()).catch(error => this.showError(error))
  },

  openGifEditor() {
    if (!this.data.drawerOpen && !this.data.isLoading && !this.data.isSaving && !this.data.isDrawing && !this.data.isPanning) {
      wx.navigateTo({ url: '/pages/gif/index' })
    }
  },

  resetEdits() {
    clearTimeout(this._drawTimer)
    this._drawTimer = null
    clearTimeout(this._previewTimer)
    this._previewTimer = null
    this._strokes = []
    this._activeStroke = null
    this._activePan = null
    this._panX = 0
    this._panY = 0
    this._base = null
    this._edited = null
    this._output = null
    this.setData({ strokeCount: 0, isDrawing: false, isPanning: false,
      isDirty: false, hasEditable: false, zoom: 1 })
  },

  async drawPreview() {
    if (this._disposed || this._hidden || !this._edited || !this._canvas) return
    if (!this._previewCanvas) {
      const result = await new Promise(resolve => {
        wx.createSelectorQuery().in(this).select('#editor-canvas')
          .fields({ node: true, size: true, rect: true }).exec(results => resolve(results[0]))
      })
      if (this._disposed || !result || !result.node || !result.width || !result.height) return
      this._previewCanvas = result.node
      this._previewRect = result
      this._previewScrollTop = this._scrollTop || 0
      const pixelRatio = typeof wx.getWindowInfo === 'function'
        ? wx.getWindowInfo().pixelRatio || 1 : 1
      result.node.width = Math.round(result.width * pixelRatio)
      result.node.height = Math.round(result.height * pixelRatio)
      this._previewRatio = pixelRatio
    }
    if (this._disposed || !this._edited) return
    const rect = this._previewRect
    const ratio = this._previewRatio
    this._previewFit = createEditorView(this._original.width, this._original.height,
      rect.width, rect.height, { zoom: this.data.zoom, panX: this._panX || 0, panY: this._panY || 0 })
    this._panX = this._previewFit.panX
    this._panY = this._previewFit.panY
    const context = this._previewCanvas.getContext('2d')
    context.clearRect(0, 0, this._previewCanvas.width, this._previewCanvas.height)
    context.drawImage(this._canvas,
      this._previewFit.x * ratio, this._previewFit.y * ratio,
      this._previewFit.width * ratio, this._previewFit.height * ratio)
  },

  paintCurrent() {
    clearTimeout(this._drawTimer)
    this._drawTimer = null
    if (this._disposed || !this._output || !this._canvas) return
    this._canvas.width = this._output.width
    this._canvas.height = this._output.height
    this._canvas.getContext('2d').putImageData(this._output, 0, 0)
    this.drawPreview().catch(error => this.showError(error))
  },

  queuePaint() {
    if (this._drawTimer || this._disposed) return
    this._drawTimer = setTimeout(() => this.paintCurrent(), 32)
  },

  queuePreview() {
    if (this._previewTimer || this._disposed) return
    this._previewTimer = setTimeout(() => {
      this._previewTimer = null
      this.drawPreview().catch(error => this.showError(error))
    }, 32)
  },

  localTouchPoint(event) {
    const touch = (event.touches && event.touches[0]) ||
      (event.changedTouches && event.changedTouches[0])
    if (!touch || !this._previewFit || !this._previewRect) return null
    if ((this._activeStroke || this._activePan) && this._touchId !== undefined &&
        touch.identifier !== undefined && touch.identifier !== this._touchId) return null
    let x = touch.x
    let y = touch.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = touch.clientX - this._previewRect.left
      const scrollDelta = (this._scrollTop || 0) - this._previewScrollTop
      y = touch.clientY - (this._previewRect.top - scrollDelta)
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  },

  touchPoint(event) {
    const local = this.localTouchPoint(event)
    return local ? viewPoint(this._previewFit, local) : null
  },

  canTransform() {
    return !this._disposed && !this._hidden && !this.data.drawerOpen && !this.data.isLoading &&
      !this.data.isSaving && !this.data.isDrawing && !this.data.isPanning &&
      this.data.previewMode === 'result' && !!this._edited
  },

  async changeZoom(event) {
    if (!this.canTransform()) return
    const step = Number(event.currentTarget.dataset.step)
    if (!Number.isFinite(step)) return
    this.setData({ zoom: clampZoom(this.data.zoom + step) })
    await this.drawPreview()
  },

  async fitPreview() {
    if (!this.canTransform()) return
    this._panX = 0
    this._panY = 0
    this.setData({ zoom: 1 })
    await this.drawPreview()
  },

  invalidateResult() {
    this.setData({ resultPath: '', isDirty: true, errorText: '',
      statusText: '手动修改已生效，保存时会生成最新透明 PNG' })
  },

  onBrushStart(event) {
    if (this._disposed || this._hidden || this.data.drawerOpen || this.data.isLoading || this.data.isSaving ||
        this.data.previewMode !== 'result' || !this._edited || this._activeStroke || this._activePan ||
        (event.touches && event.touches.length > 1)) return
    if (this.data.brushTool === 'move') {
      const local = this.localTouchPoint(event)
      if (!local) return
      this._activePan = { point: local }
      this._touchId = event.touches && event.touches[0] && event.touches[0].identifier
      this.setData({ isPanning: true })
      return
    }
    const point = this.touchPoint(event)
    if (!point || point.x < 0 || point.y < 0 ||
        point.x >= this._original.width || point.y >= this._original.height) return
    if (this.data.brushTool === 'picker') {
      const offset = (Math.floor(point.y) * this._original.width + Math.floor(point.x)) * 4
      const source = this._edited[offset + 3] === 0 ? this._original.data : this._edited
      const rgb = [source[offset], source[offset + 1], source[offset + 2]]
      const colour = '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('')
      this.setData({ brushRgb: rgb, brushColor: colour, brushTool: 'paint' })
      return
    }
    if ((this._strokes || []).length >= 100) {
      wx.showToast({ title: '最多 100 笔，请先撤销', icon: 'none' })
      return
    }
    this._activeStroke = { tool: this.data.brushTool, radius: this.data.brushRadius, points: [point] }
    if (this.data.brushTool === 'paint') this._activeStroke.color = this.data.brushRgb.slice()
    this._touchId = event.touches && event.touches[0] && event.touches[0].identifier
    applyStroke(this._edited, this._original.data, this._original.width, this._original.height, this._activeStroke)
    this.setData({ isDrawing: true })
    this.invalidateResult()
    this.queuePaint()
  },

  onBrushMove(event) {
    if (this._disposed || this.data.drawerOpen || !this._edited ||
        (event.touches && event.touches.length > 1)) return
    if (this._activePan) {
      const point = this.localTouchPoint(event)
      if (!point) return
      const previous = this._activePan.point
      this._panX = (this._panX || 0) + point.x - previous.x
      this._panY = (this._panY || 0) + point.y - previous.y
      const view = createEditorView(this._original.width, this._original.height,
        this._previewRect.width, this._previewRect.height,
        { zoom: this.data.zoom, panX: this._panX, panY: this._panY })
      this._panX = view.panX
      this._panY = view.panY
      this._previewFit = view
      this._activePan.point = point
      this.queuePreview()
      return
    }
    if (!this._activeStroke) return
    const point = this.touchPoint(event)
    if (!point) return
    const active = this._activeStroke
    if (active.points.length >= 1024) {
      this.onBrushEnd()
      wx.showToast({ title: '这笔过长，请抬手继续', icon: 'none' })
      return
    }
    const previous = active.points[active.points.length - 1]
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.25) return
    applyStroke(this._edited, this._original.data, this._original.width, this._original.height,
      { tool: active.tool, radius: active.radius, points: [previous, point], color: active.color })
    active.points.push(point)
    this.queuePaint()
  },

  onBrushEnd(event) {
    if (!this._disposed && this._activePan) {
      if (event) this.onBrushMove(event)
      this._activePan = null
      this._touchId = undefined
      this.setData({ isPanning: false })
      clearTimeout(this._previewTimer)
      this._previewTimer = null
      this.drawPreview().catch(error => this.showError(error))
      return
    }
    if (this._disposed || !this._activeStroke) return
    if (event) this.onBrushMove(event)
    if (!this._activeStroke) return
    this._strokes = this._strokes || []
    this._strokes.push(this._activeStroke)
    this._activeStroke = null
    this._touchId = undefined
    this.setData({ isDrawing: false, strokeCount: this._strokes.length })
    this.paintCurrent()
  },

  changeBrushTool(event) {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    const tool = event.currentTarget.dataset.tool
    if (['erase', 'restore', 'move', 'paint', 'picker'].includes(tool)) {
      this.setData({ brushTool: tool, previewMode: 'result' })
      nextFrame().then(() => this.drawPreview()).catch(error => this.showError(error))
    }
  },

  changeBrushRadius(event) {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    const radius = Number(event.detail.value)
    if (Number.isFinite(radius)) this.setData({ brushRadius: Math.max(1, Math.min(40, radius)) })
  },

  undoStroke() {
    if (this._disposed || this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning ||
        !this._base || !(this._strokes || []).length) return
    this._strokes.pop()
    this._edited.set(renderEditedFrame(this._base, this._original.data,
      this._original.width, this._original.height, this._strokes))
    this.setData({ strokeCount: this._strokes.length, previewMode: 'result' })
    this.invalidateResult()
    this.paintCurrent()
  },

  async getCanvas() {
    if (this._disposed) return null
    if (this._canvas) return this._canvas
    const canvas = await new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this).select('#processing-canvas')
        .fields({ node: true, size: true }).exec(results => {
          if (results[0] && results[0].node) resolve(results[0].node)
          else reject(new Error('画布未就绪，请稍后再试'))
        })
    })
    if (this._disposed) return null
    this._canvas = canvas
    return canvas
  },

  async chooseImage() {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    this.setData({ isLoading: true, errorText: '' })
    try {
      const selected = typeof wx.chooseMedia === 'function'
        ? await callWx('chooseMedia', {
          count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original']
        })
        : await callWx('chooseImage', {
          count: 1, sourceType: ['album'], sizeType: ['original']
        })
      if (this._disposed) return
      const file = selected.tempFiles[0]
      if (!file) throw new Error('没有选择图片')
      const path = file.tempFilePath || file.path
      if (!path) throw new Error('无法读取选中的图片')
      if (file.size > MAX_BYTES) throw new Error('请选择不超过 10 MB 的图片')
      await this.loadImage(path)
      if (this._disposed) return
      await this.renderResult()
    } catch (error) {
      if (!/cancel/i.test(error.errMsg || error.message || '')) this.showError(error)
    } finally {
      if (!this._disposed) this.setData({ isLoading: false })
    }
  },

  async loadImage(path) {
    const info = await callWx('getImageInfo', { src: path })
    if (this._disposed) return
    if (info.type === 'gif') throw new Error('GIF 动图请从「所有工具」打开「GIF 逐帧编辑」')
    const canvas = await this.getCanvas()
    if (!canvas || this._disposed) return
    const image = canvas.createImage()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error('图片解码失败，请换一张 JPG 或 PNG 图片'))
      image.src = path
    })
    if (this._disposed) return
    const width = image.width || info.width
    const height = image.height || info.height
    if (!width || !height) throw new Error('无法读取图片尺寸')
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const outputWidth = Math.max(1, Math.round(width * scale))
    const outputHeight = Math.max(1, Math.round(height * scale))
    canvas.width = outputWidth
    canvas.height = outputHeight
    const context = canvas.getContext('2d')
    context.clearRect(0, 0, outputWidth, outputHeight)
    context.drawImage(image, 0, 0, outputWidth, outputHeight)
    this._original = context.getImageData(0, 0, outputWidth, outputHeight)
    this.resetEdits()
    this.setData({
      originalPath: path,
      resultPath: '',
      previewMode: 'result',
      imageSize: outputWidth + ' × ' + outputHeight,
      wasResized: scale < 1,
      removedPercent: '',
      statusText: '正在移除白底…'
    })
  },

  async exportCanvas(canvas) {
    const result = await callWx('canvasToTempFilePath', {
      canvas,
      x: 0, y: 0, width: canvas.width, height: canvas.height,
      destWidth: canvas.width, destHeight: canvas.height,
      fileType: 'png'
    })
    return result.tempFilePath
  },

  async renderResult() {
    if (this._disposed || !this._original) return
    // Each adjustment starts from the original pixels, never the last result.
    this.setData({ statusText: '正在移除白底…' })
    await nextFrame()
    if (this._disposed) return
    const canvas = await this.getCanvas()
    if (!canvas || this._disposed || !this._original) return
    const source = this._original
    canvas.width = source.width
    canvas.height = source.height
    const result = removeWhiteBackground(source.data, canvas.width, canvas.height, {
      tolerance: this.data.tolerance, mode: this.data.mode, feather: 12
    })
    const context = canvas.getContext('2d')
    const output = context.createImageData(canvas.width, canvas.height)
    output.data.set(renderEditedFrame(result.data, source.data, source.width, source.height, this._strokes || []))
    context.putImageData(output, 0, 0)
    // Checkerboard and background swatches are CSS-only, not exported pixels.
    let resultPath
    try {
      resultPath = await this.exportCanvas(canvas)
    } catch (error) {
      if (!this._disposed && this._output) this.paintCurrent()
      throw error
    }
    if (this._disposed) return
    this._base = result.data
    this._output = output
    this._edited = output.data
    this.setData({
      resultPath,
      hasEditable: true,
      isDirty: false,
      removedPercent: (result.removedPixels * 100 / (canvas.width * canvas.height)).toFixed(1),
      statusText: result.removedPixels
        ? '处理完成，可以保存透明 PNG'
        : '没有找到可去除的白底，可提高强度或切换模式'
    })
    await nextFrame()
    await this.drawPreview()
  },

  async reprocess(patch) {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    const previousSettings = { tolerance: this.data.tolerance, mode: this.data.mode }
    this.setData(patch)
    if (!this._original) return
    this.setData({ isLoading: true, errorText: '' })
    try {
      await this.renderResult()
    } catch (error) {
      if (!this._disposed && (this.data.resultPath || this._edited)) this.setData(previousSettings)
      this.showError(error)
    } finally {
      if (!this._disposed) this.setData({ isLoading: false })
    }
  },

  changeTolerance(event) {
    return this.reprocess({ tolerance: Number(event.detail.value) })
  },

  changeMode(event) {
    return this.reprocess({ mode: event.detail.value ? 'all' : 'edge' })
  },

  switchPreview(event) {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    this.setData({ previewMode: event.currentTarget.dataset.mode })
    if (this.data.previewMode === 'result') {
      nextFrame().then(() => this.drawPreview()).catch(error => this.showError(error))
    }
  },

  switchBackground(event) {
    this.setData({ previewBackground: event.currentTarget.dataset.background })
  },

  previewImage() {
    const path = this.data.previewMode === 'original'
      ? this.data.originalPath : this.data.resultPath
    if (path) wx.previewImage({ current: path, urls: [path] })
  },

  async useExample() {
    if (this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    this.setData({ isLoading: true, errorText: '' })
    try {
      const canvas = await this.getCanvas()
      if (!canvas || this._disposed) return
      canvas.width = 640
      canvas.height = 480
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 640, 480)
      context.fillStyle = '#ea9670'
      context.beginPath()
      context.moveTo(210, 170)
      context.lineTo(200, 70)
      context.lineTo(290, 145)
      context.lineTo(350, 145)
      context.lineTo(440, 70)
      context.lineTo(430, 170)
      context.closePath()
      context.fill()
      context.beginPath()
      context.arc(320, 245, 132, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = '#ffffff'
      context.beginPath()
      context.arc(320, 285, 68, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = '#263c35'
      for (const x of [275, 365]) {
        context.beginPath()
        context.arc(x, 223, 9, 0, Math.PI * 2)
        context.fill()
      }
      context.beginPath()
      context.moveTo(310, 270)
      context.lineTo(330, 270)
      context.lineTo(320, 282)
      context.closePath()
      context.fill()
      const originalPath = await this.exportCanvas(canvas)
      if (this._disposed) return
      this._original = context.getImageData(0, 0, 640, 480)
      this.resetEdits()
      this.setData({
        originalPath, resultPath: '', previewMode: 'result',
        imageSize: '640 × 480', wasResized: false, removedPercent: ''
      })
      await this.renderResult()
    } catch (error) {
      this.showError(error)
    } finally {
      if (!this._disposed) this.setData({ isLoading: false })
    }
  },

  async saveImage() {
    if ((!this.data.resultPath && !this._edited) || this.data.drawerOpen || this.data.isLoading || this.data.isSaving || this.data.isDrawing || this.data.isPanning) return
    this.setData({ isSaving: true, errorText: '' })
    try {
      if (this.data.isDirty || !this.data.resultPath) {
        this.paintCurrent()
        const resultPath = await this.exportCanvas(this._canvas)
        if (this._disposed) return
        this.setData({ resultPath, isDirty: false })
      }
      await callWx('saveImageToPhotosAlbum', { filePath: this.data.resultPath })
      if (this._disposed) return
      this.setData({ needsAlbumPermission: false })
      wx.showToast({ title: '透明 PNG 已保存', icon: 'success' })
    } catch (error) {
      if (this._disposed) return
      const message = error.errMsg || error.message || ''
      if (/auth deny|auth denied|authorize|permission|denied/i.test(message)) {
        this.setData({
          needsAlbumPermission: true,
          errorText: '保存需要相册权限。请点击下方「开启相册权限」后再次保存。'
        })
      } else if (!/cancel/i.test(message)) this.showError(error)
    } finally {
      if (!this._disposed) this.setData({ isSaving: false })
    }
  },

  onAlbumSetting(event) {
    if (event.detail.authSetting && event.detail.authSetting['scope.writePhotosAlbum']) {
      this.setData({ needsAlbumPermission: false, errorText: '' })
      wx.showToast({ title: '权限已开启，请再保存', icon: 'none' })
    }
  },

  showPrivacy() {
    wx.showModal({
      title: '图片在本机处理',
      content: '图片只在你的设备上处理，不上传服务器。我们不请求登录或手机号；仅在你点击保存时将结果写入相册。',
      showCancel: false
    })
  },

  showError(error) {
    if (this._disposed) return
    const message = error.errMsg || error.message || ''
    let readable = message
    if (/privacy/i.test(message)) {
      readable = '请在小程序后台完善用户隐私保护指引，声明选择图片和保存相册的用途。'
    } else if (/chooseMedia:fail|chooseImage:fail/i.test(message)) {
      readable = '无法选择图片，请检查相册权限后重试。'
    } else if (/saveImageToPhotosAlbum:fail/i.test(message)) {
      readable = '保存失败，请检查相册权限；开发工具的保存行为与手机可能不同。'
    }
    this.setData({ errorText: readable || '处理失败，请重新选择图片', statusText: '本次操作未完成，请查看下方提示' })
    wx.showToast({ title: '未完成，请查看页面提示', icon: 'none' })
    console.warn('图片处理未完成', message)
  }
})
