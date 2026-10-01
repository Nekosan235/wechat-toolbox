const { tools } = require('../../utils/tool-catalog')
Page({
  data: { availableTools: tools.filter(t => t.available), navigating: false },
  onUnload() { this._disposed = true },
  async openTool(event) {
    if (this._disposed || this.data.navigating) return
    const tool = tools.find(t => t.available && t.id === event.currentTarget.dataset.id)
    if (!tool) return
    this.setData({ navigating: true })
    try { await new Promise((resolve, reject) => wx.navigateTo({ url: tool.route, success: resolve, fail: reject })) }
    catch (error) { if (!this._disposed) wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' }) }
    finally { if (!this._disposed) this.setData({ navigating: false }) }
  },
  showPrivacy() {
    wx.showModal({ title: '素材留在你的设备', content: '现有图片与GIF工具均在本机处理，不上传服务器，不请求登录或手机号。保存结果时需要相册权限；发送GIF只在你主动点击后进行。', showCancel: false })
  }
})
