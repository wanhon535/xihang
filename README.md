# 汐航

汐航是一个前后端分离的团队入口与轻量 SSO 导航平台：前端使用 Vite，后端使用 Express REST API，数据存储在 MySQL，支持账号密码登录、钉钉扫码登录、后台配置导航和后续接入单点登录跳转。

## 技术结构

```text
backend/              Express API、登录鉴权、MySQL 数据访问
frontend/             Vite 前端页面：首页、登录页、星钥库页、后台管理页
data/sites.json       首次初始化 MySQL 时的种子数据
sql/tidesail.sql      MySQL 建库建表和示例数据脚本
```

## 本地启动

1. 安装依赖：

```bash
npm install
```

2. 复制配置：

```bash
copy .env.example .env
```

3. 创建或准备 MySQL，并编辑 `.env`：

```ini
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=tidesail
```

后端启动时会自动创建数据库和表：

```text
users
nav_groups
nav_sites
sso_tickets
personal_credentials
```

如果 `nav_groups` 为空，会自动把 `data/sites.json` 导入 MySQL 作为初始导航数据。

也可以手动导入 SQL 文件初始化数据库：

```bash
mysql -h localhost -P 3309 -u root -p < sql/tidesail.sql
```

`sql/tidesail.sql` 包含 `CREATE DATABASE IF NOT EXISTS`、建表语句和示例数据；脚本会先删除内置示例分组再插入，可重复导入。

4. 配置登录与前端地址：

```ini
SESSION_SECRET=replace-with-a-long-random-secret
VAULT_ENCRYPTION_KEY=replace-with-another-long-random-secret
FRONTEND_ORIGIN=http://127.0.0.1:2223,http://localhost:2223
LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=admin123456
```

后端启动时会把本地管理员账号同步到 `users` 表，并以 `bcrypt` 哈希保存密码。上线前必须修改默认密码。
`VAULT_ENCRYPTION_KEY` 用于加密个人密码库中的密码字段，上线后必须固定保存；更换该值会导致历史记录无法解密。

5. 可选配置钉钉扫码登录：

```ini
DINGTALK_APP_ID=dingxxxxxxxxxxxx
DINGTALK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_REDIRECT_URI=http://127.0.0.1:2222/api/auth/dingtalk/callback
```

6. 启动前后端：

```powershell
npm.cmd run dev:backend
npm.cmd run dev:frontend
```

前端地址：

```text
http://127.0.0.1:2223
```

后端 API：

```text
http://127.0.0.1:2222
```

## 登录方式

汐航支持两种登录方式：

1. 账号密码登录：读取 `users.username` 和 `users.password_hash`。
2. 钉钉扫码登录：作为可选统一登录入口。

钉钉扫码登录成功后，会自动创建或更新 `users` 记录，保存 `nick`、`unionid`、`openid`、`role` 和 `last_login_at`。

钉钉不会向第三方应用返回用户真实密码，因此系统不会、也不能保存钉钉密码。扫码用户的 `password_hash` 会写入随机密码哈希，用于满足用户表字段约束；如果后续要允许该用户账号密码登录，应单独提供“重置密码/设置密码”功能。

## 钉钉配置要点

1. 进入钉钉开放平台，创建扫码登录/网页登录应用。
2. 获取应用的 `App ID` 和 `App Secret`，填入 `.env`。
3. 回调地址配置为 `.env` 中的 `DINGTALK_REDIRECT_URI`。
4. 本地回调地址是 `http://127.0.0.1:2222/api/auth/dingtalk/callback`。
5. 线上部署时，回调地址必须改为公网 HTTPS 地址，例如 `https://api.xihang.example.com/api/auth/dingtalk/callback`。

## 访问控制

默认只要登录成功即可访问汐航。

如需限制只有指定钉钉成员能扫码访问，可以配置：

```ini
ALLOWED_DINGTALK_UNION_IDS=unionid1,unionid2,unionid3
```

管理员识别推荐使用 `unionId`：

```ini
ADMIN_DINGTALK_UNION_IDS=unionid1,unionid2
```

也可以用钉钉昵称临时识别，默认昵称 `admin` 是管理员：

```ini
ADMIN_DINGTALK_NICKS=admin,张三
```

## 后台管理

管理员登录后可以访问：

```text
http://127.0.0.1:2223/admin.html
```

后台支持：

1. 新增、删除导航分组。
2. 新增、删除站点。
3. 修改站点名称、访问地址、说明、标签。
4. 保存后写入 MySQL，团队成员刷新首页即可看到最新配置。

站点配置只允许管理员操作：前端仅管理员显示后台入口；后端 `/api/admin/groups` 读取和保存接口同时校验登录态与管理员权限，普通成员直接请求也会返回 403。

如果还没配置真实钉钉应用，可以先用账号密码登录后台。默认账号是 `admin`，默认密码是 `.env` 中的 `LOCAL_ADMIN_PASSWORD`。

## 星钥库

登录后可以访问：

```text
http://127.0.0.1:2223/vault.html
```

星钥库是内嵌在汐航 SSO 平台里的独立功能模块，用于记录某个系统、平台或服务的登录账号和密码，方便个人后续检索。它支持新增、编辑、删除、搜索、分类、标签、收藏、密码强度提示、密码生成器、打开登录地址、显示密码、复制账号和复制密码。

权限隔离按当前登录用户实现：每条记录都绑定当前登录用户的 `users.id`，后端接口只按登录态读取和修改本人记录；现有后台管理接口不会读取其他人的星钥库。密码字段使用 AES-256-GCM 加密后写入 MySQL，列表接口不会返回明文密码，只有用户点击显示或复制密码时才会请求明文。

## API 概览

```text
GET  /api/health
GET  /api/auth/me
GET  /api/auth/dingtalk
GET  /api/auth/dingtalk/callback
POST /api/auth/password-login
POST /api/auth/logout
GET  /api/nav/groups
GET  /api/vault/credentials
POST /api/vault/credentials
PUT  /api/vault/credentials/:id
DELETE /api/vault/credentials/:id
GET  /api/vault/credentials/:id/secret
GET  /api/sso/authorize?redirect=https://target.example.com
POST /api/sso/verify
GET  /api/admin/groups
PUT  /api/admin/groups
```

## 单点登录预留

当前已预留汐航到其他系统的 SSO 跳转能力，用于实现“用户已登录汐航，点击其他平台不再重复登录”。

流程如下：

1. 用户在汐航完成登录。
2. 用户点击某个站点卡片。
3. 前端不会直接打开原始地址，而是跳到后端：

```text
GET /api/sso/authorize?redirect=https://target.example.com
```

4. 后端校验当前汐航会话，签发一个短期一次性 `sso_ticket`。
5. 后端重定向到目标系统：

```text
https://target.example.com?sso_ticket=xxxxxxxx
```

6. 目标系统收到 `sso_ticket` 后，服务端调用汐航后端校验：

```http
POST /api/sso/verify
Content-Type: application/json

{
  "ticket": "xxxxxxxx"
}
```

7. 校验成功后返回用户身份：

```json
{
  "ok": true,
  "targetUrl": "https://target.example.com",
  "user": {
    "nick": "张三",
    "unionid": "ding-unionid",
    "openid": "ding-openid"
  },
  "expiresAt": "2026-05-13T10:00:00.000Z"
}
```

8. 目标系统据此创建自己的登录态，后续用户在目标系统内访问就不再需要登录。

注意事项：

1. `sso_ticket` 默认有效期为 120 秒，可通过 `SSO_TICKET_TTL_SECONDS` 配置。
2. `sso_ticket` 是一次性的，校验成功后立即失效。
3. 后续如果接入多个正式业务系统，建议增加目标系统白名单，避免任意 `redirect` 被滥用。
4. 如果目标系统和汐航在同一主域下，也可以进一步升级为统一 Cookie 域名方案。

## 生产部署建议

1. 前端用 `VITE_API_BASE_URL=https://api.xihang.example.com npm run dev:frontend` 本地调试，正式环境使用 `npm run build:frontend` 后部署 `dist` 静态资源。
2. 后端使用 `NODE_ENV=production npm start` 启动。
3. 配置 HTTPS，确保钉钉回调地址与 `.env` 完全一致。
4. 设置足够长且随机的 `SESSION_SECRET`。
5. 多实例部署时，建议把 `express-session` 的默认内存存储替换成 Redis。

## 推送远程仓库前检查

1. 不要提交 `.env`，里面包含 MySQL 密码、钉钉 App Secret 等敏感信息。
2. 不要提交 `node_modules/`、`dist/`、`.backend-*.log`、`.frontend-*.log` 等运行或构建产物。
3. 需要提交 `package.json`、`package-lock.json`、`backend/`、`frontend/`、`data/sites.json`、`sql/tidesail.sql`、`.env.example`、`README.md`。
4. 推送前建议执行 `npm run check` 和 `npm run build:frontend`。
