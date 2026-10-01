const { parseGif, composeGifFrames } = require('./gif-decoder')
const { removeWhiteBackground } = require('./remove-white')
const { renderEditedFrame, resizeFrame } = require('./frame-editor')
const { GifEncoder } = require('./gif-encoder')

const MAX_BYTES = 8 * 1024 * 1024

class GifProject {
  constructor(bytes) {
    if (!bytes || bytes.byteLength > MAX_BYTES) throw new Error('请选择不超过 8 MB 的 GIF')
    this.gif = parseGif(bytes)
    if (this.gif.width * this.gif.height * this.gif.frameCount > 32000000) {
      throw new Error('GIF 总像素过多，请先缩小尺寸或减少帧数')
    }
    const scale = Math.min(1, 480 / Math.max(this.gif.width, this.gif.height))
    this.width = Math.max(1, Math.round(this.gif.width * scale))
    this.height = Math.max(1, Math.round(this.gif.height * scale))
    this.strokes = Array.from({ length: this.gif.frameCount }, () => [])
    this.settings = { tolerance: 32, mode: 'edge', feather: 12 }
    this.cache = new Map()
    this.iteratorIndex = -1
  }

  validateIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.gif.frameCount) throw new Error('帧序号无效')
  }

  original(index) {
    this.validateIndex(index)
    if (this.cache.has(index)) {
      const data = this.cache.get(index)
      this.cache.delete(index)
      this.cache.set(index, data)
      return data
    }
    if (!this.iterator || index <= this.iteratorIndex) {
      this.iterator = composeGifFrames(this.gif)
      this.iteratorIndex = -1
    }
    let frame
    while (this.iteratorIndex < index) {
      frame = this.iterator.next().value
      this.iteratorIndex++
    }
    const data = resizeFrame(frame.data, this.gif.width, this.gif.height, this.width, this.height)
    this.cache.set(index, data)
    if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value)
    return data
  }

  render(index) {
    const original = this.original(index)
    const base = removeWhiteBackground(original, this.width, this.height, this.settings).data
    return renderEditedFrame(base, original, this.width, this.height, this.strokes[index])
  }

  addStroke(index, stroke) {
    this.validateIndex(index)
    const total = this.strokes.reduce((sum, list) => sum + list.length, 0)
    if (this.strokes[index].length >= 100 || total >= 1000) throw new Error('编辑笔画已达上限，请撤销部分笔画再继续')
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 1024) throw new Error('笔画无效或过长')
    // Validate before recording; never let an invalid stroke poison export.
    renderEditedFrame(this.original(index), this.original(index), this.width, this.height, [stroke])
    this.strokes[index].push({ tool: stroke.tool, radius: stroke.radius,
      points: stroke.points.map(p => ({ x: p.x, y: p.y })),
      ...(stroke.tool === 'paint' ? { color: stroke.color.slice() } : {}) })
  }

  undo(index) {
    this.validateIndex(index)
    return this.strokes[index].pop()
  }

  get editedCount() { return this.strokes.filter(list => list.length).length }

  async encode({ cancelled = () => false, progress = () => {}, yieldFrame = () => Promise.resolve() } = {}) {
    const encoder = new GifEncoder(this.width, this.height, { loopCount: this.gif.loopCount })
    let index = 0
    for (const frame of composeGifFrames(this.gif)) {
      if (cancelled()) throw new Error('已取消生成')
      const original = resizeFrame(frame.data, this.gif.width, this.gif.height, this.width, this.height)
      const base = removeWhiteBackground(original, this.width, this.height, this.settings).data
      const edited = renderEditedFrame(base, original, this.width, this.height, this.strokes[index])
      encoder.addFrame(edited, frame.delay)
      progress(++index, this.gif.frameCount)
      await yieldFrame()
    }
    if (cancelled()) throw new Error('已取消生成')
    return encoder.finish()
  }
}

module.exports = { GifProject, MAX_BYTES }
