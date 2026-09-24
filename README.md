# 汐航

汐航是面向公司内部的统一登录、系统入口和个人凭证管理平台。项目采用前后端分离结构：前端由 Vite 承载页面和交互，后端由 Express 提供 REST API，业务数据存储在 MySQL。

当前版本重点能力：

- 账号密码登录和钉钉扫码登录。
- 管理员创建成员账号，不开放自助注册。
- 管理员创建或重置的本地账号首次登录必须修改密码。
- 按用户、角色和管理员身份隔离站点入口。
- 内嵌个人「星钥库」，用于保存项目、系统、网址/IP、账号和密码。
- 工作台支持个人主题、渐变背景和背景图片上传。
- 预留 SSO ticket 流程，便于已登录汐航后跳转到其他内部系统。
- 后台提供用户管理、站点管理、系统设置、审计日志和备份导出。

完整运维手册见 [XIHANG_OPERATION_MANUAL.md](./docs/XIHANG_OPERATION_MANUAL.md)。

## 技术栈

```text
Frontend   Vite + 原生 ES Module
Backend    Node.js + Express
Database   MySQL
Session    express-session + MySQL app_sessions
Crypto     bcryptjs + AES-256-GCM
SSO        DingTalk OAuth2 + internal one-time ticket
```

建议环境：

- Node.js 20 LTS 或更高版本。
- MySQL 8.x 或兼容版本。
- Windows PowerShell、CMD、Linux shell 均可运行；本文命令以 PowerShell 为主。

## 目录结构

```text
backend/src/                       后端 API、登录鉴权、SSO、MySQL 数据访问
backend/routes/                    后续路由拆分目录，当前预留
backend/controllers/               后续控制器拆分目录，当前预留
backend/middlewares/               后续中间件拆分目录，当前预留
backend/utils/                     后续工具模块拆分目录，当前预留
backend/config/                    后续环境配置拆分目录，当前预留
frontend/*.html                    Vite 多页面 HTML 入口
frontend/src/api.js                前端统一 API 封装
frontend/src/config.js             前端 API 地址配置
frontend/src/pages/                登录、工作台、星钥库、后台等页面脚本
frontend/src/styles/styles.css     全局样式
docs/XIHANG_OPERATION_MANUAL.md    运维和钉钉配置手册
docs/CLEANUP_PLAN.md               清理计划和恢复说明
docs/REFACTOR_STEPS.md             分阶段重构建议
data/sites.json                    首次启动时的导航种子数据
data/dingtalk-events.ndjson        钉钉扫码和回调事件日志
data/uploads/                      用户上传的工作台背景图，默认不提交 Git
sql/tidesail.sql                   建库建表和示例数据脚本
scripts/user-scenario-smoke.mjs    用户场景自检脚本
scripts/admin-module-smoke.mjs     管理后台自检脚本
scripts/verify-after-refactor.mjs  重构后轻量烟雾测试脚本
```

## 快速启动

安装依赖：

```powershell
npm install
```

复制配置：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少确认这些配置：

```ini
PORT=2222
FRONTEND_ORIGIN=http://127.0.0.1:2223,http://localhost:2223
SESSION_SECRET=replace-with-a-long-random-secret
VAULT_ENCRYPTION_KEY=replace-with-another-long-random-secret

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=tidesail

LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=admin123456
```

启动后端：

```powershell
npm.cmd run dev:backend
```

再开一个新窗口启动前端：

```powershell
npm.cmd run dev:frontend
```

访问地址：

```text
前端：http://127.0.0.1:2223
后端：http://127.0.0.1:2222
登录页：http://127.0.0.1:2223/login.html
后台：http://127.0.0.1:2223/admin.html
星钥库：http://127.0.0.1:2223/vault.html
```

也可以用一个命令同时启动前后端：

```powershell
npm.cmd run dev
```

本地调试时更推荐分两个窗口启动，后端报错和前端构建日志更容易看清楚。

## 数据库初始化

后端启动时会自动创建数据库表，并对旧表补齐新增字段。MySQL 账号需要具备创建表、修改表和读写数据的权限。

当前核心表：

```text
users                  用户、角色、状态、钉钉身份、本地密码哈希
nav_groups             站点分组
nav_sites              站点入口、可见范围、角色/成员授权
sso_tickets            一次性 SSO 票据
personal_credentials   个人星钥库记录
system_settings        系统设置
admin_audit_logs       管理操作审计日志
user_preferences       用户工作台外观配置
app_sessions           登录 session
cost_entries           管理员共享成本台账
cost_attachments       台账凭证附件
```

如果 `nav_groups` 为空，后端会自动导入 `data/sites.json` 作为初始导航数据。

也可以手动导入 SQL：

```powershell
mysql -h 127.0.0.1 -P 3306 -u root -p -e "source sql/tidesail.sql"
```

`sql/tidesail.sql` 已从当前数据库导出全部 11 张表的结构（含成本台账与附件），附带示例站点数据，可重复导入空库而不重复添加站点。文件默认创建/使用 `tidesail` 库，与 `.env.example` 一致。自定义数据库名时请同时修改 SQL 的 `CREATE DATABASE` / `USE` 和 `.env` 的 `MYSQL_DATABASE`。

SQL 不包含线上账号、星钥密码、账目、附件、会话或钉钉密钥。后端第一次启动会补齐系统设置并根据 `.env` 创建本地管理员，因此本地开发不依赖生产数据。已有旧库应通过后端启动执行兼容迁移，SQL 用于新建开发库。

完整本地开发步骤见 [LOCAL_DEVELOPMENT.md](./docs/LOCAL_DEVELOPMENT.md)。

## 默认账号

本地管理员由 `.env` 控制：

```ini
LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=admin123456
```

后端每次启动都会把这个账号同步为管理员，并更新为 `.env` 里的密码。生产环境必须修改默认密码，并妥善保存 `.env`。

管理员在后台创建的普通成员账号会被标记为 `must_change_password=1`，成员首次密码登录后会被强制跳转到改密码页面。

## 用户和权限模型

汐航不提供公开注册入口。账号来源只有两类：

- 管理员在后台创建的本地账号。
- 钉钉扫码登录后自动创建或匹配的成员账号。

用户角色：

```text
admin   管理员，可进入后台管理用户、站点和系统设置
member  普通成员，只能访问被授权的站点和自己的星钥库
```

用户状态：

```text
active    可登录
disabled  禁用后不可登录
```

站点入口支持四种可见范围：

```text
所有成员
仅管理员
按角色
指定成员
```

后端会在 `/api/nav/groups` 和 `/api/sso/authorize` 同时做权限过滤，普通成员即使直接请求接口也不能访问未授权入口。

## 钉钉扫码登录

`.env` 示例：

```ini
DINGTALK_CLIENT_ID=dingxxxxxxxxxxxx
DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_OAUTH_SCOPE=openid corpid Contact.User.Read
DINGTALK_OAUTH_PROMPT=consent
DINGTALK_CORP_ID=dingxxxxxxxxxxxxxxxx
DINGTALK_REDIRECT_URI=https://your-public-domain.example.com/api/auth/dingtalk/callback
DINGTALK_FORCE_IPV4=true
```

钉钉后台需要确认：

- 回调地址必须和 `DINGTALK_REDIRECT_URI` 完全一致。
- 本地调试如果钉钉要求公网 HTTPS，需要使用内网穿透地址。
- 登录 scope 使用 `openid corpid Contact.User.Read`。
- 保持 `DINGTALK_OAUTH_PROMPT=consent`，让员工重新确认授权，避免复用旧的未授权令牌。
- 应用权限需要包含 `Contact.User.Read` 或通讯录个人信息读权限。
- 通讯录接口权限范围必须包含要登录的员工。
- “应用可见范围/全员可见”和“通讯录接口权限范围”不是同一个设置。
- 如果开启 IP 白名单，以钉钉错误信息里的 `request ip=...` 为准加入白名单。

检查当前后端生成的钉钉登录 URL：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:2222/api/auth/dingtalk/url -Headers @{ Origin='http://127.0.0.1:2223' } | ConvertTo-Json -Depth 10
```

正常结果里应能看到：

```text
configured: true
scope: openid corpid Contact.User.Read
prompt: consent
redirect_uri: 当前钉钉后台配置的回调地址
```

扫码事件会写入：

```text
data/dingtalk-events.ndjson
```

实时查看：

```powershell
Get-Content -Encoding UTF8 -Wait -Tail 80 data\dingtalk-events.ndjson
```

如果仍然出现 `Forbidden.AccessDenied.AccessTokenPermissionDenied`，而日志里的授权 URL 已经包含 `Contact.User.Read` 和 `prompt=consent`，说明登录链路已经把权限请求发出去了，需要继续检查钉钉开放平台里的委托权限、通讯录接口权限范围和员工覆盖范围。

## 星钥库

星钥库是汐航内嵌的个人凭证管理模块，用于记录项目、系统、网址/IP、账号、密码、标签和备注。

当前支持：

- 新增、编辑、删除个人凭证。
- 搜索项目、账号、网址/IP、标签和备注。
- 收藏常用记录。
- 打开登录地址。
- 复制账号和密码。
- 显示密码前单独请求明文。
- 密码强度提示和密码生成器。

隔离和安全策略：

- 每条记录绑定当前登录用户的 `users.id`。
- 后端接口只读取和修改当前登录用户自己的记录。
- 后台管理不会返回其他用户的星钥库明文。
- 密码字段使用 AES-256-GCM 加密后存入 MySQL。
- `VAULT_ENCRYPTION_KEY` 上线后必须固定保存；更换后历史密码无法解密。

## 工作台外观

每个用户可以独立保存工作台外观：

- 纯色背景。
- 渐变背景。
- 自定义背景图上传。
- 个人偏好存储在 `user_preferences`。
- 上传文件存储在 `data/uploads/backgrounds`，默认已加入 `.gitignore`。

工作台外观按用户隔离，互不影响。

## 管理后台

管理员入口：

```text
http://127.0.0.1:2223/admin.html
```

管理后台当前包含：

- 总览数据。
- 用户管理：创建用户、修改角色、启用/禁用、重置密码、删除用户。
- 站点管理：创建分组、配置入口、标签、说明和可见范围。
- 系统设置：产品名称、公司名称、前端地址、密码长度、会话时长、SSO 票据有效期、是否强制钉钉登录等。
- 审计日志：记录用户、站点、设置等关键管理操作。
- 备份导出：导出当前分组、用户摘要、系统设置和概览数据。

安全约束：

- 普通成员访问后台 API 会返回 403。
- 管理员不能禁用、删除或降级自己当前登录的账号。
- 重置密码后的账号会再次进入首次改密流程。

## SSO 票据流程

汐航已预留从统一工作台跳转到其他内部系统的 SSO ticket 能力。

跳转流程：

1. 用户登录汐航。
2. 用户点击一个站点入口。
3. 前端打开：

```text
GET /api/sso/authorize?siteId=123
```

4. 后端校验登录态和站点可见权限。
5. 后端生成短期一次性 `sso_ticket`。
6. 后端重定向到目标系统：

```text
https://target.example.com?sso_ticket=xxxxxxxx
```

7. 目标系统服务端调用汐航校验：

```http
POST /api/sso/verify
Content-Type: application/json

{
  "ticket": "xxxxxxxx"
}
```

成功返回：

```json
{
  "ok": true,
  "targetUrl": "https://target.example.com",
  "user": {
    "id": 1,
    "username": "zhangsan",
    "nick": "张三",
    "role": "member",
    "unionid": "ding-unionid",
    "openid": "ding-openid"
  },
  "expiresAt": "2026-05-24T10:00:00.000Z"
}
```

说明：

- `sso_ticket` 默认有效期为 120 秒，可通过 `SSO_TICKET_TTL_SECONDS` 或后台设置调整。
- `sso_ticket` 校验成功后立即失效，不能重复使用。
- `/api/sso/authorize` 会按当前用户可见站点校验，不允许跳转到未授权地址。

## 常用 API

```text
GET    /api/health
GET    /api/auth/me
POST   /api/auth/password-login
POST   /api/auth/change-password
POST   /api/auth/logout

GET    /api/auth/dingtalk
GET    /api/auth/dingtalk/url
GET    /api/auth/dingtalk/callback
POST   /api/auth/handoff-login
POST   /api/auth/dingtalk/client-log

GET    /api/nav/groups
GET    /api/user/workspace-theme
PUT    /api/user/workspace-theme
POST   /api/user/workspace-theme/background

GET    /api/vault/credentials
POST   /api/vault/credentials
PUT    /api/vault/credentials/:id
DELETE /api/vault/credentials/:id
GET    /api/vault/credentials/:id/secret

GET    /api/sso/authorize
POST   /api/sso/verify

GET    /api/admin/overview
GET    /api/admin/users
POST   /api/admin/users
PUT    /api/admin/users/:id
DELETE /api/admin/users/:id
POST   /api/admin/users/:id/reset-password
GET    /api/admin/groups
PUT    /api/admin/groups
GET    /api/admin/settings
PUT    /api/admin/settings
GET    /api/admin/audit-logs
GET    /api/admin/backup
```

## 常用命令

```powershell
npm.cmd run dev:backend
npm.cmd run dev:frontend
npm.cmd run dev
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
npm.cmd start
```

命令说明：

```text
dev:backend          使用 node --watch 启动后端，默认端口 2222
dev:frontend         启动 Vite 前端，默认端口 2223
dev                  同时启动前后端
check                检查后端语法
build:frontend       构建前端到 dist
test:user-scenarios  跑用户场景和后台模块自检
start                启动后端生产进程
```

## 端口和前后端分离

默认端口：

```text
后端 PORT=2222
前端 Vite=2223
```

如果要换后端端口：

- 修改 `.env` 的 `PORT`。
- 修改 `.env` 的 `FRONTEND_ORIGIN`。
- 修改钉钉后台回调地址和 `.env` 的 `DINGTALK_REDIRECT_URI`。
- 前端默认会请求当前主机的 `2222`，生产或改端口时建议设置 `VITE_API_BASE_URL`。

本地临时指定前端 API 地址：

```powershell
$env:VITE_API_BASE_URL='http://127.0.0.1:2222'
npm.cmd run dev:frontend
```

如果只想换前端端口，可以直接运行：

```powershell
npx vite --host 127.0.0.1 --port 2224 --strictPort
```

同时要把 `.env` 的 `FRONTEND_ORIGIN` 加上新前端地址。

## 生产部署建议

后端：

```powershell
$env:NODE_ENV='production'
npm.cmd start
```

前端：

```powershell
$env:VITE_API_BASE_URL='https://api.xihang.example.com'
npm.cmd run build:frontend
```

部署要求：

- 后端使用 HTTPS，钉钉回调地址必须和 `.env` 完全一致。
- 前端静态资源部署 `dist`。
- 生产环境改掉默认管理员密码。
- `SESSION_SECRET` 使用足够长的随机值。
- `VAULT_ENCRYPTION_KEY` 单独保存，不能丢失或随意更换。
- `.env` 不提交 Git。
- 多实例部署时当前 session 可共用 MySQL；流量更大时再考虑 Redis。

## 排查手册

后端是否正常：

```powershell
Invoke-RestMethod http://127.0.0.1:2222/api/health
```

前端打不开：

- 确认 `npm.cmd run dev:frontend` 正在运行。
- 确认端口 `2223` 没被其他进程占用。
- 确认浏览器访问的是 `http://127.0.0.1:2223`。

密码登录后不跳转：

- 调用 `/api/auth/me` 看是否已有用户态。
- 如果 `mustChangePassword=true`，会跳转到 `/change-password.html`。
- 如果后台开启了强制钉钉登录，普通成员不能使用密码登录，管理员不受影响。

钉钉二维码不显示：

- 先请求 `/api/auth/dingtalk/url` 看 `configured` 是否为 `true`。
- 检查 `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET` 和 `DINGTALK_REDIRECT_URI`。
- 浏览器强刷登录页：`http://127.0.0.1:2223/login.html?tab=dingtalk&v=manual-check`。

扫码后不跳转：

- 查看 `data/dingtalk-events.ndjson` 是否出现 `callback.received`。
- 如果没有回调，检查钉钉后台回调地址和内网穿透地址。
- 如果有 `callback.success` 但前端不跳，查看登录页的“前端事件检测”。
- 如果出现 `invalid_state_or_missing_code`，刷新登录页重新扫码。

钉钉权限错误：

- 确认 URL 有 `scope=openid corpid Contact.User.Read`。
- 确认 URL 有 `prompt=consent`。
- 确认员工手机端同意授权。
- 确认钉钉后台通讯录接口权限范围包含该员工。
- 确认 IP 白名单包含当前后端出口 IP。

## 提交前检查

```powershell
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
```

不要提交：

```text
.env
node_modules/
dist/
data/uploads/
.backend-*.log
.frontend-*.log
```

需要提交：

```text
package.json
package-lock.json
backend/
frontend/
data/sites.json
sql/tidesail.sql
.env.example
README.md
docs/XIHANG_OPERATION_MANUAL.md
scripts/
```
