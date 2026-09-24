# 首页四季氛围与信息精简

2026-09-24，已发布首页。

- 仅工作台首页加载 `seasonal-particles.js`，Canvas 在内容下方，`pointer-events: none`、`aria-hidden`、整体透明度 0.4。
- 自动季节：3–5 月春、6–8 月夏、9–11 月秋、12–2 月冬。使用浏览器日期，每分钟检查自动季节。
- 「外观 → 首页季节氛围」可选择自动、四季或关闭。即时生效，按账号 ID 存储于当前浏览器 localStorage，无需点击外观保存；不承诺跨设备同步。
- 12–44 个粒子，按视口面积调整；低配模式上限 20。绘制上限分别 24/20 FPS，像素比上限 1.5/1。不使用滤镜、实时阴影或粒子间连线。
- 页面不可见、关闭效果、系统减少动态效果时取消动画循环。pagehide 保存位置并停止循环，pageshow 恢复。当前多页架构在返回首页时由 sessionStorage 恢复位置；页内锚点/筛选不重建 Canvas。
- 四季：粉白花瓣左右摆动、黄绿萤火呼吸、橙黄棕叶片旋转、白/浅蓝慢雪与少量六角雪花。
- 首页正文重复标题隐藏，欢迎语替换、删除欢迎区导航按钮及右侧重复快捷菜单，目录扩展为整行；统计分别使用文件夹、链接、钥匙、服务器 SVG。

## 验证

- 12 个月的季节边界检查通过。
- 服务器 Playwright 检查四季切换、单实例 Canvas、关闭持久化、减少动态效果、搜索、仅首页加载、位置快照、手机分辨率及无横向溢出。
- 模拟低配设备和动画时钟：一秒 20 次绘制、20 粒子、DPR 1；隐藏后 0 待执行帧、恢复后 1 循环、pagehide 清理为 0。
- 首页截图已在服务器查看：`/tmp/tidesail-vben-review/home-seasons-final.png`。服务器 Chromium 的 GPU 初始化不稳定，测试使用 `--disable-gpu`，没有调用用户桌面。
- 浏览器测试使用模拟业务数据，不修改真实业务数据。脚本：`/tmp/tidesail-layout-tools/particles-check.mjs`、`particles-performance.mjs`、`home-seasons-visual.mjs`。
- 备份：`/tmp/tidesail-before-seasons.tar.gz`。只替换首页 HTML 并添加哈希资源，保留其他页面 HTML 与原资源。
