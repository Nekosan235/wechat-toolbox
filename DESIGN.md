# iOS 风格工具箱

## 本次重构计划与行为边界

现有图片/GIF处理、手动擦除、还原、撤销和导出链路保持不变。已有自动化测试作为回归基线，另增加首页导航、工具抽屉开合、手势、未开放入口、操作锁定和路由配置测试。先实现共享导航外壳，再分别调整两个编辑页，最后全量测试和微信独立编译。

用户指定 iOS 风格和抽屉式入口。本项目交付微信原生页面，不另建 HTML 原型，也不使用 Apple 商标、SF 字体文件或假 iPhone 状态栏。花叔 Design 的内容克制与层级原则用于布局；HTML 演示专属流程不适用于这个原生项目。

## 信息架构

- 首页：工具箱；展示已可用的图片去白和 GIF 逐帧编辑。
- 功能入口：底部工具抽屉，默认中等高度；拖动顶部手柄可展开、收起或关闭，并提供可点击关闭/展开按钮。
- 编辑页：保留独立完整页面；抽屉只负责功能选择，不把画笔和复杂编辑塞进半屏面板。
- 未来入口：智能抠图、视频去白、内容修复，统一标注“待开放”，不跳转到虚假的功能页。
- 切换新工具采用页面压栈，已有页面可以通过微信返回按钮找回；达到页面栈上限时提示返回，不自动销毁编辑结果。

## 视觉与交互

颜色是微信端项目适配值，不宣称等同 UIKit 动态系统色：背景 #F2F2F7、面板 #FFFFFF、正文 #1C1C1E、辅助 #636366、主操作 #0064D9。系统字体栈，标题约34px、正文17px、说明不低于14px；不加装饰插图、宣传数据、持续动画。

按钮与颜色色块的触控区最少44px，按压有背景反馈。原图/效果、擦除/还原用等宽分段控件；撤销和导出保持独立。底部操作与抽屉预留安全区域。抽屉打开时停止GIF播放，阻止底下Canvas画笔触摸，不重建Canvas节点。动效短且有方向，支持减少动态效果的CSS降级。

## 官方参考

研究智能体实际读取Apple公开HIG正文：

- https://developer.apple.com/design/human-interface-guidelines/sheets
- https://developer.apple.com/design/human-interface-guidelines/buttons
- https://developer.apple.com/design/human-interface-guidelines/typography
- https://developer.apple.com/design/human-interface-guidelines/segmented-controls
- https://developer.apple.com/design/human-interface-guidelines/color
- https://developer.apple.com/design/human-interface-guidelines/accessibility
- https://developer.apple.com/design/human-interface-guidelines/motion

44pt与微信rpx不是同一单位，采用最小44px命中区的保守适配；不机械写44rpx。官方建议正文17pt、大标题34pt，微信使用相近视觉层级，不声称支持原生Dynamic Type。#007AFF配白色小文字的对比不足4.5:1，本项目采用较深蓝主按钮。

## 验证限制

手动精修新增1～8倍缩放和移动模式，预览采用独立视图变换与逆坐标映射，导出仍使用完整原输出像素。画笔按RGB不透明覆盖，取色器点击当前编辑图像取色（去白后的透明区回退原图），移动/取色不计笔画。每笔记录工具、原始图片坐标与颜色快照，撤销重新重放；不会从屏幕截图导出裁切画面。两页共享editor-view与frame-editor，所有模式切换在笔画/拖动进行期间锁定，避免预览变换中途改变坐标。

自动化检查可以验证处理像素、导航状态、抽屉手势与WXML/WXSS编译，不能代替微信真机Canvas触摸、抽屉覆盖层、字体放大与相册GIF动画保留的验收。开发工具控制授权未建立，不能宣称已操作实际软件窗口。
