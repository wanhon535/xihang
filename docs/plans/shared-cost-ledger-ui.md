# TideSail 共享成本台账与全站样式 Implementation Plan

> **For Hermes:** 按 TDD 逐项实施，本次不提交、不重启生产，主 agent 审查发布。

**Goal:** 所有管理员共用成本记录与凭证，普通成员无访问权限；统一所有现有页面基础视觉与交互状态。

**Architecture:** Express 独立台账 router，复用 requireLogin/requireAdmin 并强制数据库刷新后的 admin role。MySQL IF NOT EXISTS 建表，金额整数分、汇总 BigInt，乐观锁避免覆盖；凭证 BLOB 单独表，仅授权路由可读，不进公开静态目录。原有页面共享 CSS 最后导入统一增强样式，新增独立 ledger 页面避免侵入旧管理模块。

**Tech Stack:** Node 原生测试、Express、MySQL、原生前端 JS、Vite。

## 核查与备份
- 当前生产分支原 main，干净；PM2 tidesail online 且 watch=false。
- 页面：工作台、登录、改密、管理中枢、星钥库；共用 styles.css。
- 生产 MySQL 已有 users/session/audit/settings 等九表，无成本表。角色 admin/member；现存普通成员。
- 现有 smoke 会修改站点/设置，必须通过全新隔离数据库运行，禁止对生产跑。
- 源码及 dist 备份：/var/backups/tidesail/20260923-102552-ledger-ui/source-dist.tar.gz（不含 .env/data/node_modules）；旧版本及 dist hash 同目录。

## 执行步骤
1. 新增 tests/cost-ledger.test.mjs：金额、日期、长度、付款状态、凭证格式、汇总；确认未实现时失败。
2. 新增 backend/src/cost-ledger.js：纯校验、非破坏性迁移、共享 CRUD（新增/更新，无删除）、授权凭证上传下载、审计、版本冲突 409。接入 server.js 的认证后 router，initDatabase 时建表。
3. 新增隔离数据库 HTTP 测试：未登录401、成员403（含昵称admin）、管理员A新建/B查看修改、金额验证、附件下载保护、版本冲突、持久化和汇总。先红后绿。
4. 新增 frontend/ledger.html、src/pages/ledger.js 及纯视图模型；月份/项目/类别/付款状态筛选、搜索、排序、分组汇总；总成本/本月/待付款。新增/编辑 dialog、凭证、错误重试、空/加载状态；admin导航链接。
5. 新增 shared-ui.css 并通过全部页面加载：字体、间距、焦点、按钮、表单、导航、表格、弹窗、移动端、减少动画。保持自定义工作台主题兼容。
6. 运行 node --test tests/*.test.mjs；在新建测试数据库运行原 smoke；语法检查；npm run build:frontend -- --outDir /var/backups/tidesail/20260923-102552-ledger-ui/candidate-dist。
7. 校验生产 dist hash 未变、无生产迁移/重启。交接修改清单、验证结果、候选 dist、部署与回滚步骤。

## 发布约束
API_BASE_URL 保持空字符串；createSsoUrl 保持 window.location.origin 完整URL。不上线新 dist、不启动生产代码、不修改生产数据库、不重启其他进程。金额仅接受正值且最多两位小数，单条上限 999999999.99 元；附件限制 PNG/JPEG/PDF 3MiB 并强制下载。
