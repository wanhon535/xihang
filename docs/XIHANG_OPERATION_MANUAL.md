# 汐航使用与运维手册

适用对象：汐航平台管理员、部署人员、内部测试人员。

## 1. 项目定位

汐航是企业内部统一入口与项目凭证平台，当前包含：

- 本地账号密码登录与钉钉扫码登录。
- 登录后进入工作台，按权限展示站点入口。
- 管理员维护用户、角色、站点入口、权限范围和系统配置。
- 星钥库按用户隔离保存项目账号、密码、网址、IP 和备注。
- 工作台支持每个用户自定义纯色、渐变和上传图片背景。

## 2. 本地启动

后端端口：`2222`

前端端口：`2223`

分开启动：

```powershell
npm.cmd run dev:backend
npm.cmd run dev:frontend
```

一起启动：

```powershell
npm.cmd run dev
```

访问地址：

```text
http://127.0.0.1:2223
```

健康检查：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:2222/api/health
```

## 3. 必要环境配置

`.env` 至少需要：

```ini
PORT=2222
FRONTEND_ORIGIN=http://127.0.0.1:2223,http://localhost:2223
SESSION_SECRET=replace-with-a-long-random-secret
VAULT_ENCRYPTION_KEY=replace-with-another-long-random-secret

LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=change-this-password

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=tidesail
```

注意：

- `SESSION_SECRET` 用于 session、钉钉 state 和扫码登录交接 token 签名。
- `VAULT_ENCRYPTION_KEY` 用于加密星钥库密码，上线后不要更换，否则旧密码无法解密。
- `.env` 不要提交到 Git。

## 4. 钉钉扫码登录配置

`.env` 示例：

```ini
DINGTALK_CLIENT_ID=dingxxxxxxxxxxxx
DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DINGTALK_OAUTH_SCOPE=openid corpid Contact.User.Read
DINGTALK_OAUTH_PROMPT=consent
DINGTALK_CORP_ID=dingxxxxxxxxxxxxxxxx
DINGTALK_REDIRECT_URI=https://your-public-domain.example.com/api/auth/dingtalk/callback
```

钉钉后台必须配置：

- 回调地址必须和 `DINGTALK_REDIRECT_URI` 完全一致。
- 本地测试如果钉钉要求公网 HTTPS，使用内网穿透地址。
- 回调路径固定为 `/api/auth/dingtalk/callback`。
- 应用权限需要包含读取当前授权用户基础信息的权限，常见为 `Contact.User.Read` 或通讯录个人信息读权限；授权链接 scope 也必须包含 `Contact.User.Read`。
- 建议保持 `DINGTALK_OAUTH_PROMPT=consent`，让员工重新确认授权，避免旧授权令牌没有包含 `Contact.User.Read`。
- 如果用户级 `userAccessToken` 不能调用个人信息接口，系统会继续用企业内部应用接口按授权码换员工 `userid`，本地账号按 `dingtalk_corp_id + dingtalk_userid` 匹配。
- 通讯录接口权限范围必须包含要登录的员工。应用“可见范围/全员可见”和“接口权限范围”不是同一个设置。

扫码流程：

1. 前端请求 `GET /api/auth/dingtalk/url`。
2. 后端生成钉钉 OAuth URL，并带上 `state`。
3. 登录页 iframe 展示钉钉扫码页。
4. 用户扫码授权后，钉钉回调后端。
5. 后端读取钉钉用户信息，自动创建或更新本地账号。
6. 后端生成 2 分钟有效的 `auth_handoff` 交接 token。
7. 前端用 `POST /api/auth/handoff-login` 换成本地登录态。
8. 成功后进入工作台或首次改密页面。

## 5. 钉钉问题排查

实时查看钉钉日志：

```powershell
Get-Content -Encoding UTF8 -Wait -Tail 100 .backend-dev.log | Select-String "\[dingtalk\]|error|failed"
```

检查授权 URL：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:2222/api/auth/dingtalk/url -Headers @{Origin='http://127.0.0.1:2223'} | ConvertTo-Json -Depth 10
```

正常结果应包含：

- `configured: true`
- `scope` 实际 URL 中包含 `openid corpid Contact.User.Read`
- `prompt` 实际 URL 中为 `consent`
- `redirect_uri` 是当前内网穿透 HTTPS 回调地址

如果员工扫码后出现 `Forbidden.AccessDenied.AccessTokenPermissionDenied`：

- 先看日志里的 `token.response`。
- 如果 `hasUnionId` 或 `hasOpenId` 为 `true`，系统会走 `profile.fallback`，仍可自动创建账号。
- 如果 `hasUnionId=false` 且 `hasOpenId=false`，系统会继续看 `employee-code.response` 是否拿到 `userid`。
- 如果日志里的授权 URL 已经包含 `Contact.User.Read` 和 `prompt=consent`，手机端仍返回该错误，重点检查钉钉开放平台的委托权限/接口权限范围是否真的覆盖该员工。

如果扫码后没有跳转：

- 看日志是否有 `callback.success`。
- 有 `callback.success` 但没有 `handoff.success`，多半是前端没有收到 `auth_handoff` 或浏览器拦截 iframe 跳转。
- 有 `handoff.success` 说明后端登录已经成功，前端应跳转到工作台。
- 如果出现 `invalidParameter.authCode.notFound`，通常是同一个授权码被重复请求或旧二维码过期，刷新登录页后重新扫码。

如果钉钉返回 `60020` 或 `访问ip不在白名单之中`：

- 以钉钉错误里的 `request ip=...` 为准，把这个 IP 加到应用 IP 白名单。
- 本地宽带出口 IP 可能变化，截图里看到的 IP 和钉钉实际识别到的出口 IP 可能不一致。
- `.env` 默认开启 `DINGTALK_FORCE_IPV4=true`，后端会优先使用 IPv4 调用钉钉接口；如果仍被拦截，把最新错误里的 IPv4 加入白名单，或本地测试期间临时关闭 IP 白名单。

## 6. 用户和权限规则

管理员入口：

```text
http://127.0.0.1:2223/admin.html
```

支持：

- 创建本地成员账号。
- 分配管理员或普通成员角色。
- 启用、禁用、删除成员账号。
- 重置临时密码。
- 维护站点入口可见范围。

首次登录规则：

- 管理员创建的本地账号默认 `must_change_password = 1`。
- 用户第一次登录后必须进入改密页面。
- 管理员重置密码后，用户下次登录也必须改密。
- 钉钉扫码自动创建的账号默认不要求改密。

## 7. 站点入口和 SSO

入口位置：后台管理 -> 站点矩阵。

每个站点入口支持设置可见范围：

- 所有成员。
- 仅管理员。
- 按角色。
- 指定成员。

隔离规则：

- 只有管理员可以新增、删除、保存站点分组和站点入口。
- 前台 `GET /api/nav/groups` 会按当前登录用户过滤入口。
- SSO 跳转 `GET /api/sso/authorize` 复用同一套可见入口校验，不能绕过工作台直接跳未授权站点。
- 管理员默认可见全部入口，便于检查和维护。

## 8. 星钥库规则

入口：

```text
http://127.0.0.1:2223/vault.html
```

星钥库保存内容：

- 项目或系统名称。
- 登录账号。
- 密码或密钥。
- 网址或 IP。
- 标签、备注、常用标记。

隔离规则：

- 每条凭证绑定当前登录用户的 `users.id`。
- 后端查询、修改、删除都带 `user_id` 条件。
- 普通成员只能看到自己的记录。
- 管理后台不展示其他人的明文密码。

## 9. 工作台外观

入口：工作台右上角 `外观`。

支持：

- 纯色背景。
- 渐变背景。
- 渐变角度。
- 暗化强度。
- 上传 JPG、PNG、WebP、GIF 背景图。

限制：

- 图片最大 5MB。
- 文件保存到 `data/uploads/backgrounds/<user_id>/`。
- `data/uploads/` 已加入 `.gitignore`。
- 外观配置保存在 `user_preferences.workspace_theme`，按用户隔离。

## 10. 验证命令

代码语法检查：

```powershell
npm.cmd run check
node --check backend/src/db.js
```

前端构建：

```powershell
npm.cmd run build:frontend
```

完整用户场景模拟：

```powershell
npm.cmd run test:user-scenarios
```
