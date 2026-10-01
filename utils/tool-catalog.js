// Add tools here once. Unavailable tools deliberately have no route.
const tools = [
  { id: 'image', title: '图片去白底', note: '自动去白、擦除与还原，保存透明 PNG', format: 'PNG', available: true, route: '/pages/index/index' },
  { id: 'gif', title: 'GIF 逐帧编辑', note: '逐帧去白与手动修整，保留动画节奏', format: 'GIF', available: true, route: '/pages/gif/index' },
  { id: 'cutout', title: '智能抠图', note: '复杂背景与主体识别', format: 'AI', available: false },
  { id: 'video', title: '视频去白底', note: '视频透明素材处理', format: '视频', available: false },
  { id: 'repair', title: '内容修复', note: '移除遮挡并补全画面', format: '修复', available: false }
]
module.exports = { tools }
