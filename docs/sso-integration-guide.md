# 汐航 SSO 接入指南（给被接入系统的开发者 / AI 助手）

> 汐航要作为公司内部系统的唯一入口。以后任何新系统只要希望"从汐航点进去自动登录"，都按这份文档接入即可，不需要单独设计鉴权方案。把这份文档整篇丢给负责该系统的开发者或 AI 助手就够了。

**汐航部署地址：`https://xigouoa.xyz`**（前端和 API 是同一个地址，`/api/...` 直接拼在后面即可）。已启用 HTTPS，ticket 在传输过程中是加密的。

## 一句话说清楚这是什么

用户先登录汐航，在汐航的应用目录里点一个入口，汐航会带着一个**一次性、短时效的 ticket** 把浏览器重定向到你的系统；你的系统后端拿这个 ticket 换用户身份，然后建立你自己系统的登录态。全程你的系统不需要知道用户的密码，也不需要接入钉钉——身份验证的脏活都在汐航这边做完了。

## 前置条件：先在汐航后台登记你的系统

汐航只会给**已经在"站点矩阵"里登记过 URL 的系统**签发 ticket，没登记的地址一律拒绝（403）。这一步由汐航管理员在 管理中枢 → 站点矩阵 里完成，不需要被接入系统的开发者操心，但要提前对齐好：

- 系统的入口 URL（ticket 会带在这个 URL 的 query string 上重定向过去）
- 哪些角色/用户能看到并跳转到这个系统（汐航侧的可见性配置）

## 接入方（你的系统）只需要做两件事

### 1. 识别带 ticket 的请求

用户从汐航跳过来时，URL 会是：

```
https://你的系统域名/任意路径?sso_ticket=<64位十六进制字符串>&其他你自己的参数...
```

你的后端路由要能识别 `sso_ticket` 这个 query 参数。

### 2. 服务端用 ticket 换身份（一次性，必须在服务端做）

```http
POST https://xigouoa.xyz/api/sso/verify
Content-Type: application/json

{ "ticket": "拿到的那个 sso_ticket 值" }
```

**成功**（200）：

```json
{
  "ok": true,
  "targetUrl": "https://你的系统域名/...",
  "user": {
    "id": 17,
    "username": "zhangsan",
    "nick": "张三",
    "role": "member",
    "unionid": "",
    "openid": ""
  },
  "expiresAt": "2026-09-24T10:32:00.000Z"
}
```

**失败**（401，ticket 无效/过期/已经被用过）：

```json
{ "ok": false, "message": "ticket 无效或已过期。" }
```

**失败**（400，请求体没带 ticket）：

```json
{ "ok": false, "message": "ticket 不能为空。" }
```

拿到 `user` 之后，按你自己系统的账号体系去"查找或创建"一个本地用户，建立你自己系统的 session/cookie，然后把地址栏里的 `sso_ticket` 参数去掉（避免用户刷新页面时把已经用过的 ticket 又发一次，虽然发了也没用，但地址栏留着不好看）。

## 如果你的系统目前完全没有登录限制，必须先补上这一步

有些系统之前是内网直接访问，没有账号体系，谁都能打开——这种情况**只做上面"识别 ticket、换身份"两步是不够的**：用户完全可以跳过汐航，直接打开你系统自己的地址，照样能用，SSO 形同虚设，汐航也就没法真正成为唯一入口。

除了前面两步，你还需要给系统本身补两样东西：

1. **给所有需要保护的页面/接口加一层"必须登录"的校验**（各框架叫法不同，session middleware / auth guard 都是这个意思）：没有本地登录态（session/cookie）的请求，一律不放行。
2. **没登录时不要自己造登录页，直接跳回汐航**：因为你的系统本来就没有账号密码体系，正确的做法是重定向到汐航首页 `https://xigouoa.xyz/`，让用户在汐航那边登录（账号密码或钉钉扫码），登录后从汐航的应用目录点回你的系统入口——这时候才会带着 ticket 跳回来，走前面讲的换身份流程。

伪代码（在原来的 `/sso-callback` 路由基础上，再加一层全局校验）：

```js
// 挂在所有需要登录保护的路由前面（在 /sso-callback 路由注册之前）
app.use((req, res, next) => {
  if (req.path === '/sso-callback') return next(); // 换身份的回调路由本身不能被这层拦住
  if (req.session.userId) return next(); // 已经建立过本地登录态，放行
  res.redirect('https://xigouoa.xyz/'); // 没登录：跳回汐航，走 SSO
});
```

加完之后把系统里的页面/接口过一遍：确认哪些确实应该公开（比如健康检查 `/healthz`），哪些应该被这层拦住——别漏保护，也别把不该拦的也拦了。

## 身份字段怎么用——尤其注意这条

| 字段 | 说明 | 能不能当账号关联的主键 |
|---|---|---|
| `id` | 汐航内部用户的数据库主键，数字，稳定不变 | **推荐用这个**，只要是同一个汐航账号，这个值永远不变 |
| `username` | 汐航本地登录账号名（钉钉登录的用户可能没有） | 可以做展示/兜底，不如 `id` 稳 |
| `nick` | 显示昵称，用户自己可以改 | **不要用来做账号匹配**，会重名会改名 |
| `role` | 用户在汐航里的角色（`admin`/`member`） | 仅供参考。是否给这个用户管理员权限，你的系统应该有自己的一套权限体系，不要直接照搬汐航的角色 |
| `unionid` / `openid` | 钉钉身份，钉钉扫码登录的用户才有值 | 本地账号（账号密码登录、没绑定钉钉）这两个字段是**空字符串**，不要假设它一定有值 |

一句话：**账号关联首选 `id`**，它对本地账号和钉钉账号都稳定存在；`unionid` 只作为"这个人是不是通过钉钉登录"的辅助信息，不要作为主匹配键，否则本地账号用户会匹配失败。

## 安全上必须遵守的几条

1. **ticket 只能在你的后端换身份，绝对不能在前端 JS 里直接调用 `/api/sso/verify`**——这个接口没有登录态校验（本来就是给服务器之间调用的），谁拿到 ticket 谁能换身份，所以 ticket 本身就是敏感信息，泄露了等于泄露了一次登录机会。
2. **ticket 是一次性的**：换过一次之后立刻失效（数据库事务里原子标记 `consumed_at`），不会给你第二次换的机会，也不需要你自己做防重放。
3. **ticket 有效期很短**：默认 120 秒，汐航管理员可以在 30~3600 秒之间调整（管理中枢 → 安全策略 → SSO 票据有效秒数）。你的系统收到带 `sso_ticket` 的请求后要**立刻**去换，不要先做别的耗时操作再换。
4. **换身份失败要给用户一个清楚的提示**（比如"登录已过期，请重新从汐航进入"），并给一个能回到汐航首页的链接，不要死循环重定向。
5. 汐航已经是 HTTPS 部署，`/api/sso/verify` 走的就是加密传输，不需要额外担心明文泄露；但 ticket 依然是"谁拿到谁能换身份"的敏感值，还是要遵守前面几条（服务端调用、一次性、短时效）。
6. **你的系统接收跳转的那个地址，也必须是 HTTPS**，不能是 http。ticket 是跟在跳转 URL 的 query string 上传过来的，汐航这边是加密传输，但如果你的系统入口还是 http，ticket 到你这一段就会变成明文，前面的加固等于白做了一半。
7. **网关/Nginx 访问日志默认会把完整 URL（包括 `sso_ticket` 参数）记下来**，请在你的接入日志里把这个参数脱敏或直接过滤掉，避免 ticket 明文留在日志文件里被翻出来（虽然过期很快，但换身份前的这段时间窗口依然有效）。

## 服务端伪代码（Node/Express 举例，其他语言照抄逻辑就行）

```js
app.get('/sso-callback', async (req, res) => {
  const ticket = req.query.sso_ticket;
  if (!ticket) return res.redirect('/'); // 没带 ticket，走你自己的正常登录页

  const resp = await fetch('https://xigouoa.xyz/api/sso/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket })
  });
  const payload = await resp.json();

  if (!payload.ok) {
    return res.status(401).send('登录已过期，请从汐航重新进入本系统。');
  }

  // 用 payload.user.id 查找或创建你自己系统的本地用户
  const localUser = await findOrCreateUserByXihangId(payload.user.id, payload.user);

  // 建立你自己系统的登录态（session/JWT 都行，这部分完全是你自己系统的事）
  req.session.userId = localUser.id;

  // 去掉 URL 里的 sso_ticket，跳到系统首页
  res.redirect('/');
});
```

## 汐航侧涉及到的代码位置（供排查问题用）

- 生成 ticket、重定向：`backend/src/server.js` 的 `GET /api/sso/authorize`
- 校验站点权限：`backend/src/server.js` 的 `resolveAuthorizedSsoTarget`
- 核销 ticket：`backend/src/server.js` 的 `POST /api/sso/verify`
- ticket 存取逻辑：`backend/src/db.js` 的 `createSsoTicket` / `consumeSsoTicket`
- ticket 有效期配置：管理中枢 → 安全策略 → `ssoTicketTtlSeconds`（对应 `system_settings` 表）
