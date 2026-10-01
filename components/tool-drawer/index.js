const { tools } = require('../../utils/tool-catalog')
Component({
  properties: {
    activeTool: { type: String, value: '' },
    disabled: { type: Boolean, value: false },
    fullWidth: { type: Boolean, value: false }
  },
  data: { open: false, expanded: false,
    availableTools: tools.filter(t => t.available), futureTools: tools.filter(t => !t.available) },
  lifetimes: { detached() { this._disposed = true } },
  pageLifetimes: { hide() { this.close() } },
  methods: {
    open() {
      if (this.properties.disabled || this._navigating || this._disposed) return
      this.setData({ open: true, expanded: false })
      this.triggerEvent('visibilitychange', { open: true })
    },
    close() {
      if (!this.data.open || this._disposed) return
      this.setData({ open: false, expanded: false })
      this.triggerEvent('visibilitychange', { open: false })
    },
    toggleExpanded() { this.setData({ expanded: !this.data.expanded }) },
    blockTouch() {},
    touchY(event) {
      const touch = event.touches && event.touches[0]
      if (!touch) return null
      const y = Number.isFinite(touch.clientY) ? touch.clientY : Number.isFinite(touch.pageY) ? touch.pageY : touch.y
      return Number.isFinite(y) ? y : null
    },
    dragStart(event) { this._dragStart = this.touchY(event); this._dragEnd = this._dragStart },
    dragMove(event) { const y = this.touchY(event); if (y !== null) this._dragEnd = y },
    dragEnd() {
      if (this._dragStart === null || this._dragStart === undefined || this._dragEnd === null) return
      const delta = this._dragEnd - this._dragStart
      this._dragStart = null
      if (delta < -30) this.setData({ expanded: true })
      else if (delta > 100 || (delta > 55 && !this.data.expanded)) this.close()
      else if (delta > 40) this.setData({ expanded: false })
    },
    async selectTool(event) {
      if (this.properties.disabled || this._navigating || this._disposed) return
      const tool = tools.find(t => t.id === event.currentTarget.dataset.id)
      if (!tool) return
      if (!tool.available) { wx.showToast({ title: '此功能待开放', icon: 'none' }); return }
      if (tool.id === this.properties.activeTool) { this.close(); return }
      // Keep existing editing pages. Never redirect/relaunch to make space.
      if (getCurrentPages().length >= 9) { wx.showToast({ title: '请先点左上角返回，再切换工具', icon: 'none' }); return }
      this._navigating = true
      this.close()
      try { await new Promise((resolve, reject) => wx.navigateTo({ url: tool.route, success: resolve, fail: reject })) }
      catch (error) { if (!this._disposed) wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' }) }
      finally { this._navigating = false }
    }
  }
})
