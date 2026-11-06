# 星钥库对外 API（v1）

供外部系统调用星钥库（个人凭据库）的 REST 接口。使用 **Bearer Token** 鉴权，与浏览器会话相互独立。

- 服务地址：`http://<host>:9989`
- 所有响应均为 JSON，成功时 `ok: true`
- 代码位置：路由 `backend/src/server.js`，数据层 `backend/src/db.js`（`api_tokens` 表）

---

## 一、鉴权

请求头二选一：

```http
Authorization: Bearer xh_vault_xxxxxxxxxxxxxxxx
```

```http
X-API-Token: xh_vault_xxxxxxxxxxxxxxxx
```

**重要特性**

| 特性 | 说明 |
|---|---|
| 明文不落库 | 数据库只存 SHA-256 摘要，明文仅在创建时返回一次，丢失只能重建 |
| 用户隔离 | 令牌绑定创建者，只能读写该用户自己的记录，无法跨用户访问 |
| 密钥加密绑定用户 | 密码用 `userId` 派生的 AES-256-GCM 密钥加密，因此**不能绕过 API 直接写库** |
| 限流 | 每个令牌 120 次/分钟 |
| 失效条件 | 被吊销、已过期、或所属用户被禁用 |

错误码：

| 状态码 | 含义 |
|---|---|
| 401 | Token 无效、已过期或已吊销 |
| 403 | Token 缺少所需 scope |
| 404 | 记录不存在或不属于该令牌用户 |
| 400 | 参数校验失败（如缺 `title`、`url` 格式错误） |

---

## 二、Scope 权限

创建令牌时指定，可选值：

| Scope | 权限 |
|---|---|
| `vault:read` | 读取记录列表与详情（**不含密码明文**） |
| `vault:secret` | 读取密码明文 |
| `vault:write` | 新增 / 修改 / 删除记录 |

未传 `scopes` 时默认 `["vault:read"]`。写入类接口需 `vault:write`，读密钥需 `vault:secret`。

---

## 三、接口

### 1. 列出全部记录

```http
GET /api/v1/vault/credentials
```

需要 scope：`vault:read`

```json
{
  "ok": true,
  "total": 2,
  "credentials": [
    {
      "id": 12,
      "title": "阿里云控制台",
      "loginUsername": "ops@example.com",
      "category": "服务器",
      "tags": ["云", "运维"],
      "isFavorite": true,
      "url": "https://ecs.console.aliyun.com",
      "notes": "主账号，注意 MFA",
      "createdAt": "2026-09-29T02:10:00.000Z",
      "updatedAt": "2026-09-29T02:10:00.000Z"
    }
  ]
}
```

### 2. 查询单条

```http
GET /api/v1/vault/credentials/:id
```

需要 scope：`vault:read`，返回 `{ ok, credential }`。

### 3. 读取密码明文

```http
GET /api/v1/vault/credentials/:id/secret
```

需要 scope：`vault:secret`

```json
{ "ok": true, "secret": { "id": 12, "title": "阿里云控制台", "password": "明文密码" } }
```

### 4. 新增记录

```http
POST /api/v1/vault/credentials
Content-Type: application/json
```

需要 scope：`vault:write`，成功返回 `201`。

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✅ | 记录名称，最长 180 |
| `password` | ✅ | 密码/密钥，加密存储 |
| `loginUsername` | | 账号 |
| `category` | | 分类，默认 `默认` |
| `tags` | | 数组或逗号分隔字符串，最多 12 个 |
| `isFavorite` | | 布尔，收藏置顶 |
| `url` | | 支持 `https://...`、域名、`IP:端口`、`localhost:端口` |
| `notes` | | 备注 |

### 5. 修改记录

```http
PUT /api/v1/vault/credentials/:id
```

需要 scope：`vault:write`。

⚠️ **字段为全量覆盖**：未传的字段会被置空。但 `password` 例外——**不传 `password` 字段则保留原密码**，传空字符串会报错「密码不能为空」。

### 6. 删除记录

```http
DELETE /api/v1/vault/credentials/:id
```

需要 scope：`vault:write`，返回 `{ ok: true }`。

---

## 四、令牌管理

需浏览器登录会话（非 Bearer Token），供用户在星钥库页面自助管理。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/vault/tokens` | 列出自己的令牌（只含前缀，无明文） |
| `POST` | `/api/vault/tokens` | 创建，返回一次性明文 `token` |
| `DELETE` | `/api/vault/tokens/:id` | 吊销（保留记录，软删除） |
| `DELETE` | `/api/vault/tokens/:id/permanent` | 永久删除 |

创建请求体：

```json
{ "name": "内部同步服务", "scopes": ["vault:read", "vault:secret"], "expiresInDays": 90 }
```

响应：

```json
{
  "ok": true,
  "token": "xh_vault_3f2a...（仅此一次返回）",
  "apiToken": { "id": 3, "name": "内部同步服务", "prefix": "xh_vault_3f2a1b", "scopes": ["vault:read","vault:secret"], "expiresAt": null, "lastUsedAt": null, "revokedAt": null, "createdAt": "..." }
}
```

`expiresInDays` 不传或 ≤0 表示永不过期（上限 3650 天）。

---

## 五、调用示例

### 列出记录

```bash
curl -s http://127.0.0.1:9989/api/v1/vault/credentials \
  -H "Authorization: Bearer $VAULT_TOKEN" | jq
```

### 新增记录

```bash
curl -s -X POST http://127.0.0.1:9989/api/v1/vault/credentials \
  -H "Authorization: Bearer $VAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"测试库","loginUsername":"root","password":"Secret123!","category":"数据库","tags":["mysql"],"url":"db.example.com:3306"}'
```

### Node.js

```js
const BASE = 'http://127.0.0.1:9989';
const TOKEN = process.env.VAULT_TOKEN;

async function vault(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${res.status}: ${data.message}`);
  return data;
}

// 列出
const { credentials } = await vault('/api/v1/vault/credentials');

// 新建
const { credential } = await vault('/api/v1/vault/credentials', {
  method: 'POST',
  body: JSON.stringify({ title: '测试库', password: 'Secret123!' })
});

// 取密码
const { secret } = await vault(`/api/v1/vault/credentials/${credential.id}/secret`);
console.log(secret.password);
```

### Python

```python
import os, requests
BASE, TOKEN = 'http://127.0.0.1:9989', os.environ['VAULT_TOKEN']
H = {'Authorization': f'Bearer {TOKEN}'}

r = requests.get(f'{BASE}/api/v1/vault/credentials', headers=H, timeout=10)
r.raise_for_status()
for c in r.json()['credentials']:
    print(c['id'], c['title'], c['loginUsername'])
```

---

## 六、安全建议

1. **最小权限**：只读场景只给 `vault:read`；仅确需读取密码时才加 `vault:secret`。
2. **设置有效期**：长期服务建议 `expiresInDays: 365`，定期轮换。
3. **不要提交到代码库**：用环境变量或密钥管理注入。
4. **仅内网暴露**：该接口无 IP 白名单，建议只在内网或经反向代理鉴权后暴露。
5. **`vault:secret` 令牌风险最高**：等同可解密该用户全部密码，泄露后立即吊销。
6. 每次调用会更新 `last_used_at`，可据此排查异常调用。

---

## 七、变更记录

| 日期 | 内容 |
|---|---|
| 2026-09-29 | 新增 v1 对外 API 与 `api_tokens` 令牌体系，端到端测试 22/22 通过 |

实现文件：

- `backend/src/db.js` — `api_tokens` 表结构、`createApiToken` / `listApiTokens` / `revokeApiToken` / `deleteApiToken` / `resolveApiToken` / `touchApiTokenLastUsed`
- `backend/src/server.js` — `requireApiToken` 中间件、`/api/v1/vault/*` 路由、`/api/vault/tokens` 管理路由
