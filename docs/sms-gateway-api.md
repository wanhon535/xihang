# 汐构短信网关 · 接口文档

**服务名**：`xigou-sms-gateway`
**版本**：1.0.0
**提供方**：汐航后端（TideSail API）
**用途**：外部系统（Python 脚本 / 钉钉人员加入流程 / 任何服务）通过 HTTP 触发短信发送

**更新**：2026-09-26 — 域名上线 + 新增钉钉侧「固定参数模式」

---

## 目录

| 节 | 内容 | 适用读者 |
| --- | --- | --- |
| 1 | 接入信息 + **两种鉴权模式对比** | **所有人必读** |
| 2 | 请求说明（HMAC 模式）| 后端服务 |
| 3 | 签名算法（重点）| 后端服务 |
| 4 | 响应说明 + 错误码总表 | 所有人 |
| 5 | 完整调用示例（Python，零依赖）| 后端服务 |
| 6 | curl 自测 | 排障 |
| 7 | 服务端配置项 | 运维 |
| 8 | 「钉钉人员加入」对接建议 | 后端服务 |
| 9 | 已过审的短信模板 | 所有人 |
| **10** | **固定参数模式（钉钉侧专用）⭐** | **钉钉接入方** |

> 🚀 **只想快点发一条短信？** 跳到 **第 10 节**，一条 `curl` 就能发，不用算签名。

## 1. 接入信息

| 项目 | 值 |
| --- | --- |
| **基础地址（推荐）** | **`https://xigouoa.xyz`** ← 域名 + HTTPS，走 nginx 反代 |
| 基础地址（备用） | `http://42.193.159.241:9988`（IP 直连，**无 TLS，仅排障用**）|
| 基础地址（内网） | `http://127.0.0.1:9989` |
| 短信发送 | `POST /api/sms/send` |
| 回执查询 | `POST /api/sms/query` |
| 探活 | `GET  /api/sms/health`（无需鉴权）|
| 内容类型 | `application/json; charset=utf-8` |

**DNS**：`xigouoa.xyz → 42.193.159.241`
**TLS**：Let's Encrypt，`CN=xigouoa.xyz`，**到期 2026-12-25**

> ⚠️ 固定 token 是长期凭证，**务必走 HTTPS 域名**。走明文 HTTP 一旦被中间人截获
> 等于凭证泄露，任何人都能群发短信。IP 直连只用于排障。

---

## 1.1 两种鉴权模式（按调用方选择）

| | **A. HMAC 签名模式** | **B. 固定参数模式** |
| --- | --- | --- |
| 适用调用方 | Python / Node / 后端服务 | **钉钉自定义机器人 / 宜搭连接器** |
| 凭证 | `Key ID` + `Key Secret` | 单个固定 `X-SMS-Token` |
| 请求头 | 4 个 `X-SMS-*` 签名头 | 1 个 `X-SMS-Token` |
| 防重放 | nonce + 时间戳窗口 | 限流 + 幂等 |
| 模板限制 | 任意已过审模板 | **仅白名单内模板** |
| 文档位置 | 第 3 节 | **第 10 节** |

> 两条路**并存**，互不影响。钉钉侧算不了 HMAC，所以走 B。

### 密钥（模式 A 用）

| 项目 | 值 |
| --- | --- |
| `Key ID` | `xigou` |
| `Key Secret` | 见 `/root/sms_gateway_secret.txt`（权限 600）|

> ⚠️ Secret 等同于密码，请只放在服务端配置里，**不要**写进前端代码或提交到 Git 仓库。

---

## 2. 请求说明

### 2.1 请求头

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `Content-Type` | 是 | `application/json; charset=utf-8` |
| `X-SMS-Key` | 是 | 固定值 `xigou` |
| `X-SMS-Timestamp` | 是 | Unix 时间戳（**秒**）。与服务端偏差不得超过 **300 秒** |
| `X-SMS-Nonce` | 是 | 随机串，**每次请求必须唯一**（建议 24 位十六进制）。防重放 |
| `X-SMS-Signature` | 是 | 签名，小写十六进制（见第 3 节）|

### 2.2 请求体

```json
{
  "phone": ["13800138000"],
  "templateCode": "SMS_512081074",
  "templateParam": { "name": "张三" },
  "signName": "云南汐构信息技术有限公司",
  "content": "",
  "requestId": "welcome-zhangsan-20260926"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `phone` | string \| string[] | **是** | 手机号，单个或数组。支持 `+86` 前缀、空格、连字符，服务端自动清洗。单次最多 **100** 个 |
| `templateCode` | string | 否 | 短信模板 Code，如 `SMS_512081074`。不传用服务端默认模板 |
| `templateParam` | object | 否 | 模板变量。**键名不带 `${}`**，如 `{"name":"张三"}` 对应模板里的 `${name}` |
| `signName` | string | 否 | 短信签名。不传用服务端默认签名 |
| `content` | string | 否 | 短信正文。**仅当**默认模板是「自定义内容」类型时才使用 |
| `requestId` | string | 否 | **幂等键**。相同 `requestId` 重复提交不会重复发送，直接返回首次结果。强烈建议对「人员加入」这类场景传入，例如 `join-{钉钉userid}` |

---

## 3. 签名算法（重点）

### 3.1 待签名字符串

用 `\n` 连接以下 **5 行**，顺序不可变：

```
METHOD
PATH
TIMESTAMP
NONCE
SHA256_HEX(RAW_BODY)
```

- `METHOD`：`POST`（大写）
- `PATH`：`/api/sms/send`（固定，不带域名、不带查询串）
- `TIMESTAMP`：与 `X-SMS-Timestamp` 完全一致的字符串
- `NONCE`：与 `X-SMS-Nonce` 完全一致的字符串
- `SHA256_HEX(RAW_BODY)`：对**实际发出的请求体字节**做 SHA-256，取小写十六进制。空 body 时用 `sha256("")` 的值

> ⚠️ **最容易踩的坑**：`RAW_BODY` 必须是**真正发出去的那串字节**。
> 必须先把 JSON 序列化成字符串，**同一个字符串**既用来签名、又用来发送。
> 不要「签一次、发一次」分别序列化 —— 键顺序或空格不同就会导致签名失败。

### 3.2 计算签名

```
signature = HMAC_SHA256(key = KeySecret, message = 待签名字符串)  → 小写十六进制
```

### 3.3 Python 参考实现

```python
import hashlib, hmac, json, secrets, time

def sign(secret, method, path, timestamp, nonce, raw_body):
    string_to_sign = "\n".join([
        method.upper(),
        path,
        str(timestamp),
        nonce,
        hashlib.sha256(raw_body.encode("utf-8")).hexdigest(),
    ])
    return hmac.new(
        secret.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

body = {"phone": ["13800138000"], "templateParam": {"name": "张三"}}
# 关键：序列化一次，签名与发送共用
raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
timestamp = int(time.time())
nonce = secrets.token_hex(12)
signature = sign(SECRET, "POST", "/api/sms/send", timestamp, nonce, raw_body)
```

### 3.4 Node.js 参考实现

```js
import crypto from 'node:crypto';

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function sign(secret, method, path, timestamp, nonce, rawBody) {
  const stringToSign = [method.toUpperCase(), path, String(timestamp), nonce, sha256Hex(rawBody)].join('\n');
  return crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex');
}

const body = { phone: ['13800138000'], templateParam: { name: '张三' } };
const rawBody = JSON.stringify(body);           // 签名与发送共用
const timestamp = Math.floor(Date.now() / 1000);
const nonce = crypto.randomBytes(12).toString('hex');
const signature = sign(SECRET, 'POST', '/api/sms/send', timestamp, nonce, rawBody);
```

> 💡 中文变量值（如 `"张三"`）务必用 UTF-8 编码参与哈希。Python 用 `ensure_ascii=False`，Node 直接 `JSON.stringify` 即可，两边结果一致。

---

## 4. 响应说明

### 4.1 成功

HTTP **200**

```json
{
  "ok": true,
  "data": {
    "requestId": "welcome-zhangsan-20260926",
    "bizId": "900619886471496932^0",
    "results": [
      { "phone": "13800138000", "code": "OK", "message": "发送成功" }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `requestId` | 本次请求的幂等键（幂等命中时返回首次的键）|
| `bizId` | 阿里云回执 ID，可用于在阿里云控制台查回执 |
| `results[].code` | 单个号码的结果。`OK` = 已受理（**不等于已送达**）|
| `results[].message` | 结果描述 |

### 4.2 失败

```json
{
  "ok": false,
  "code": "SMS_AUTH_BAD_SIGNATURE",
  "message": "签名校验失败。"
}
```

### 4.3 错误码总表

| HTTP | code | 含义 | 处理建议 |
| --- | --- | --- | --- |
| 400 | `SMS_PHONE_EMPTY` | 未传 phone 或为空 | 检查请求体 |
| 400 | `SMS_PHONE_INVALID` | 手机号格式不合法 | 检查号码 |
| 400 | `SMS_PHONE_TOO_MANY` | 号码数超过 100 | 分批发送 |
| 400 | `SMS_TEMPLATE_PARAM_INVALID` | `templateParam` 不是对象 | 传对象，不是字符串 |
| 401 | `SMS_AUTH_MISSING` | 缺鉴权请求头 | 补齐 4 个 `X-SMS-*` 头 |
| 401 | `SMS_AUTH_BAD_KEY` | Key ID 不存在 | 检查 `X-SMS-Key` |
| 401 | `SMS_AUTH_BAD_SIGNATURE` | 签名不匹配 | 见第 3.1 节，重点查「序列化是否复用」|
| 401 | `SMS_AUTH_EXPIRED` | 时间戳偏差超 300 秒 | 校准服务器时间（NTP）|
| 401 | `SMS_AUTH_BAD_TIMESTAMP` | 时间戳不是合法数字 | 传秒级整数 |
| 409 | `SMS_AUTH_REPLAY` | nonce 已被用过 | 每次请求生成新 nonce |
| 500 | `SMS_UPSTREAM_ERROR` | 阿里云返回错误 | 看 `message` 与 `upstreamCode` |
| 502 | `SMS_NETWORK_ERROR` | 调用阿里云网络异常 | 重试 |
| 503 | `SMS_NOT_CONFIGURED` | 服务端未配置阿里云 AccessKey | 联系管理员配置 |
| 503 | `SMS_NOT_AVAILABLE` | 网关未启用 | 联系管理员 |

> 幂等命中时，HTTP 仍为 **200**，且响应体与首次完全一致（`requestId` 相同）。

---

## 5. 完整调用示例（Python，零依赖）

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import hashlib, hmac, json, secrets, time, urllib.request, urllib.error

GATEWAY_URL = "https://xigouoa.xyz"   # 走域名 + HTTPS；IP 直连 http://42.193.159.241:9988 仅排障
KEY_ID      = "xigou"
KEY_SECRET  = "1595a9331928bb318537947e97fe5173816f88299ddd9e05e0c5c46aa1e7a4a7"
PATH        = "/api/sms/send"

def send_sms(phone, template_code=None, template_param=None, request_id=None):
    if isinstance(phone, str):
        phone = [phone]
    body = {"phone": phone}
    if template_code:  body["templateCode"]  = template_code
    if template_param: body["templateParam"] = template_param
    if request_id:     body["requestId"]     = request_id

    raw_body  = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    timestamp = int(time.time())
    nonce     = secrets.token_hex(12)

    sts = "\n".join([
        "POST", PATH, str(timestamp), nonce,
        hashlib.sha256(raw_body.encode("utf-8")).hexdigest(),
    ])
    signature = hmac.new(KEY_SECRET.encode("utf-8"), sts.encode("utf-8"), hashlib.sha256).hexdigest()

    req = urllib.request.Request(
        GATEWAY_URL + PATH,
        data=raw_body.encode("utf-8"),
        headers={
            "Content-Type":     "application/json; charset=utf-8",
            "X-SMS-Key":        KEY_ID,
            "X-SMS-Timestamp":  str(timestamp),
            "X-SMS-Nonce":      nonce,
            "X-SMS-Signature":  signature,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read().decode("utf-8", "replace"))
        raise RuntimeError("[%s] %s: %s" % (e.code, payload.get("code"), payload.get("message"))) from None

if __name__ == "__main__":
    # 欢迎新人
    print(send_sms(
        "13800138000",
        template_code="SMS_512081074",
        template_param={"name": "张三"},
        request_id="join-dingtalk-zhangsan",
    ))
```

完整的可直接复用客户端（含探活、批量、异常类）见仓库文件：
`docs/sms-gateway-client.py`

---

## 6. curl 自测（便于快速排错）

```bash
# 1) 探活（无需鉴权）
curl -s https://xigouoa.xyz/api/sms/health

# 2) 固定参数模式发送（钉钉侧同款，一条命令搞定）
curl -s -X POST https://xigouoa.xyz/api/sms/send \
  -H 'Content-Type: application/json' \
  -H "X-SMS-Token: $SMS_GATEWAY_FIXED_TOKEN" \
  -d '{"phone":"13800138000","templateParam":{"name":"张三"},"requestId":"join-test001"}'

# 3) 查回执
curl -s -X POST https://xigouoa.xyz/api/sms/query \
  -H 'Content-Type: application/json' \
  -H "X-SMS-Token: $SMS_GATEWAY_FIXED_TOKEN" \
  -d '{"bizId":"<上一步返回的 bizId>"}'

# 4) HMAC 模式（签名需动态生成，建议直接用第 5 节 Python 脚本）
```

> 期望结果：health 四个布尔全 `true`；send 返回 `HTTP 200` + `bizId`。

---

## 7. 服务端配置项

阿里云凭证支持两种来源，**优先读环境变量（`.env`），其次读管理中枢「系统设置」**：

`.env`（服务器 `/var/www/TideSail/.env`）：

| 变量 | 说明 |
| --- | --- |
| `SMS_GATEWAY_KEY_ID` | 网关 Key ID，当前 `xigou` |
| `SMS_GATEWAY_KEY_SECRET` | 网关固定密钥 |
| `ALIYUN_SMS_ACCESS_KEY_ID` | 阿里云 AccessKey ID |
| `ALIYUN_SMS_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret |
| `ALIYUN_SMS_SIGN_NAME` | 默认短信签名 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 默认模板 Code |

管理中枢 → 系统设置 → 键名：`smsAccessKeyId` / `smsAccessKeySecret` / `smsSignName` / `smsTemplateCode`

---

## 8. 对接「钉钉人员加入」建议

1. 钉钉回调「用户加入」事件 → 你的 Python 服务收到 `userid`
2. 调钉钉 API 取手机号 + 姓名
3. 调本网关发送欢迎短信：

```python
send_sms(
    phone,
    template_code="SMS_512081074",
    template_param={"name": name},
    request_id="join-%s" % userid,     # 幂等：钉钉事件重复推送也不会重复发短信
)
```

`request_id` 用 `join-{userid}` 可以天然防重 —— 钉钉事件推送有重试机制，同一人重复推送时第二次会直接命中幂等、不扣费。

---

## 9. 已过审的短信模板（当前账号实测可用）

| 模板 Code | 名称 | 用途 | 变量 | 说明 |
| --- | --- | --- | --- | --- |
| `SMS_512081074` | 欢迎新员工 | 入职欢迎 | `${name}` | **当前默认模板**，`.env` 的 `ALIYUN_SMS_TEMPLATE_CODE` 指向它 |
| `SMS_512530328` | 工作通知 | **Agent 任务通知** | `${name}` `${content}` | 2026-09-26 新增，已过审。适合「XX 已完成，请及时处理」类通知 |
| `SMS_339005026` | 验证码短信 | 验证码 | `${code}` | 保留备用，暂不启用 |

**签名**：`云南汐构信息技术有限公司`（已过审）

### 9.1 「工作通知」模板 `SMS_512530328`（新）

**模板原文**：`${name}您好，${content},请及时处理！如已处理请忽略。`

**实际下发效果**：

```
【云南汐构信息技术有限公司】万釔宏您好，您的漫剧《长夜将明》第3集分镜已生成完毕,请及时处理！如已处理请忽略。
```

**两个变量**：

| 变量 | 说明 | 约束 |
| --- | --- | --- |
| `name` | 接收人姓名 | 同「个人姓名」类型，**仅收中文人名**；非中文会降级为「同事」（见 9.2） |
| `content` | 通知正文 | 自由文本，**建议 ≤ 30 字**，过长会被运营商截断 |

```bash
curl -X POST https://xigouoa.xyz/api/sms/send \
  -H "Content-Type: application/json" \
  -H "X-SMS-Token: <SMS_GATEWAY_FIXED_TOKEN>" \
  -d '{
    "phone": "13094376165",
    "templateCode": "SMS_512530328",
    "templateParam": {
      "name": "万釔宏",
      "content": "您的漫剧《长夜将明》第3集分镜已生成完毕"
    },
    "requestId": "agent-task-1001"
  }'
```

> ⚠️ 用这个模板必须**显式传 `templateCode`**，否则会走服务端默认模板（欢迎新员工），
> 变量名对不上会报 `isv.SMS_TEMPLATE_PARAM_ERROR`。
> 且该模板需在 `SMS_GATEWAY_FIXED_TEMPLATE_CODES` 白名单内，否则 403。

### 9.2 模板变量的两个坑（实测）

**坑 1：`name` 绑定了「个人姓名」变量类型，只收中文人名**

阿里云在**下发前**做值校验，以下形态会被拒：

```
isv.TEMPLATE_PARAMS_ILLEGAL
模版中的变量name(wanhong)不符合[个人姓名]的变量规范!
```

| 传入值 | 结果 |
| --- | --- |
| `陈鑫明`、`王五`、`欧阳娜娜`、`阿依古丽·买买提` | ✅ 原样发送 |
| `wanhong`、`zhangsan`、`Zhang San`、`Alice Wong`、`E1024` | → **自动降级为「同事」**，短信仍发出 |

这是阿里云侧规则，网关代码改不了。网关已加**智能回退**：非中文人名自动换成中性称呼
（`同事`），保证短信发得出去而不是整条失败。响应里会明确告知：

```json
{
  "ok": true,
  "bizId": "831415790432630748^0",
  "nameFallback": true,
  "nameFallbackFrom": "wanhong",
  "nameFallbackTo": "同事",
  "nameFallbackNote": "原姓名不符合阿里云「个人姓名」变量规范（仅收中文人名），已降级为中性称呼以保证送达。"
}
```

> 想彻底支持英文名，只能去阿里云控制台**新建模板**并把 `${name}` 选为「字符串」类型，
> 代码层无解。旧模板审核期会中断，不建议改现有模板。

**坑 2：传 `templateCode` 时变量名必须与模板严格匹配**

欢迎新人模板要传 `{"name":"张三"}`；工作通知模板要传 `{"name":"...","content":"..."}`。
键名不匹配报 `isv.SMS_TEMPLATE_PARAM_ERROR`。

新增模板需在阿里云控制台提交审核，通过后把 Code 加进 `SMS_GATEWAY_FIXED_TEMPLATE_CODES`
白名单即可，**无需改代码**（改完记得 `pm2 restart tidesail --update-env`）。


---

## 10. 固定参数模式（钉钉侧专用）⭐

> 2026-09-26 上线。钉钉自定义机器人 / 宜搭连接器**算不了 HMAC 签名**，只能发固定请求；
> 但裸 token 泄露即可无限群发短信。本模式 = 「固定请求」+ 三道防滥用锁。

### 10.1 请求格式（钉钉侧只需拼这一个固定请求）

**接口地址：`POST https://xigouoa.xyz/api/sms/send`**

```bash
POST https://xigouoa.xyz/api/sms/send
Content-Type: application/json
X-SMS-Token: <SMS_GATEWAY_FIXED_TOKEN>      # 固定常量，值见 /root/sms_gateway_fixed_token.txt

# 用法一：入职欢迎（可省略 templateCode，走默认模板）
{
  "phone": "13800138000",
  "templateParam": { "name": "陈鑫明" },
  "requestId": "join-13800138000"
}

# 用法二：Agent 工作通知（必须显式传 templateCode）
{
  "phone": "13800138000",
  "templateCode": "SMS_512530328",
  "templateParam": { "name": "陈鑫明", "content": "EP1 分镜已生成完毕" },
  "requestId": "agent-task-1001"
}
```

**成功响应**（HTTP 200）：

```json
{
  "ok": true,
  "bizId": "810003690413992391^0",
  "phone": "130****0000",
  "templateCode": "SMS_512081074",
  "message": "网关已受理（不代表已送达，回执请调用 /api/sms/query）",
  "requestId": "01A0DCFD-7194-5E4C-BB2C-0982FB573299"
}
```

> ⚠️ `ok:true` 只代表**网关已受理**，不等于已送达。要确认送达请调 `POST /api/sms/query`
> （body 传 `bizId`，见 10.6）。

### 10.2 字段说明

| 字段 | 是否固定 | 说明 |
|---|---|---|
| `X-SMS-Token` | ✅ 固定 | 唯一凭证，写在钉钉侧常量里 |
| `templateCode` | 可省略 | 省略即走服务端默认模板；显式传则必须在白名单内 |
| `phone` | 变 | 目标手机号 |
| `templateParam.name` | 变 | 员工姓名 |
| `requestId` | 建议传 | 幂等键，**强烈建议用钉钉 userid**，防重复推送重复发 |

### 10.3 三道防滥用锁（防滥用的核心）

1. **固定 token** — `X-SMS-Token` 不对直接 401，且不会继续走 HMAC 路径（避免探测）。
2. **模板白名单** — `SMS_GATEWAY_FIXED_TEMPLATE_CODES` 之外的模板一律 403。
   默认只放开 `SMS_512081074`（欢迎新人）。白名单留空 = 只允许服务端默认模板，
   **绝不放行调用方自选模板**（否则等于开放任意短信内容）。
3. **限流** — 按 token 分桶，每分钟 + 每天双上限（`SMS_GATEWAY_RATE_PER_MIN` /
   `SMS_GATEWAY_RATE_PER_DAY`），超限返回 429：
   - `SMS_RATE_LIMIT_MINUTE` 每分钟超限
   - `SMS_RATE_LIMIT_DAY` 每天超限

### 10.4 幂等（重要，钉钉场景必读）

钉钉事件回调是**「至少一次」投递**，同一事件可能重复推送。网关带 `requestId`
时在 TTL（默认 24h）内只真正发送一次，重复请求直接返回首次结果并带
`"idempotent": true`，**不消耗上游额度、不重复计费**。

```json
{ "ok": true, "bizId": "810003690413992391^0", "idempotent": true }
```

> ⚠️ 钉钉侧务必把 `requestId` 设成**稳定值**（如 `join-{dingtalk_userid}` 或事件 id），
> 不要每次随机生成，否则幂等形同虚设。
>
> 实测踩坑：初版 `requestId` 只回显未落缓存，同一 requestId 打两次返回**两个不同
> bizId**（真发了两次）。现已修复。

### 10.5 错误码

| code | HTTP | 含义 |
|---|---|---|
| `SMS_AUTH_BAD_TOKEN` | 401 | 固定 token 不正确 |
| `SMS_TEMPLATE_NOT_ALLOWED` | 403 | 模板不在白名单内 |
| `SMS_RATE_LIMIT_MINUTE` | 429 | 每分钟限流 |
| `SMS_RATE_LIMIT_DAY` | 429 | 每天限流 |
| `SMS_PHONE_INVALID` | 400 | 手机号格式错误 |
| `SMS_UPSTREAM_isv.TEMPLATE_PARAMS_ILLEGAL` | 502 | **模板变量值不符合校验**，见下 |

### ⚠️ 模板变量校验坑（实测踩到）

欢迎新人模板 `SMS_512081074` 的 `${name}` 在阿里云侧绑定了**变量类型 = 个人姓名**，
会做真实姓名校验。实测：

- `张三`、`李四` → ✅ 通过
- `甲`、`测试员工`、`HMAC测试`、`x` → ❌ `isv.TEMPLATE_PARAMS_ILLEGAL`
  「模版中的变量name(甲)不符合[个人姓名]的变量规范!」

**推论**：钉钉侧传的 `name` 必须是**像真名的 2~4 个中文字**。如果钉钉给的字段是
英文名/工号（如 `zhangsan`、`E1024`），会直接发送失败。
两个选择：

1. 钉钉侧传中文姓名（推荐，最简单）；
2. 到阿里云控制台把该模板的 `${name}` 变量类型从「个人姓名」改成「字符串」，
   之后任意内容都能过（但会失去姓名格式校验）。

---

### 10.6 回执查询

固定 token 模式同样可查回执（同一鉴权中间件）：

```bash
curl -s -X POST https://xigouoa.xyz/api/sms/query \
  -H 'Content-Type: application/json' \
  -H "X-SMS-Token: $SMS_GATEWAY_FIXED_TOKEN" \
  -d '{"phone":"13000000000","sendDate":"20260926","bizId":"157721190414152875^0"}'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| **`phone`** | **✅ 必填** | 手机号。**别名 `bizId` 代替不了它**，漏传会报 `SMS_PHONE_EMPTY` |
| `sendDate` | **✅ 必填** | 发送日期，`yyyyMMdd` 或 `yyyy-MM-dd`。漏传报 `SMS_SEND_DATE_INVALID` |
| `bizId` | 否 | 回执 ID，**只用于过滤**，不能替代 `phone` |

> ⚠️ 实测踩坑：只传 `bizId` 会返回 `400 SMS_PHONE_EMPTY`「手机号不能为空」。
> `phone` + `sendDate` 是**必填**，`bizId` 仅作为附加过滤条件。

**响应**（实测真实返回）：

```json
{
  "ok": true,
  "totalCount": 18,
  "pending": false,
  "details": [
    {
      "phone": "130****0000",
      "sendStatus": 3,
      "sendStatusText": "已送达",
      "errCode": "",
      "sendDate": "2026-09-26 17:14:35",
      "receiveDate": "2026-09-26 17:15:20",
      "content": "【云南汐构信息技术有限公司】张三您好，欢迎加入云南汐构……"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `totalCount` | 匹配到的记录总数 |
| `details[].sendStatus` | **1 = 在途　2 = 失败　3 = 已送达** |
| `details[].sendStatusText` | 状态中文，直接展示用 |
| `details[].errCode` | 投递错误码。**空字符串 = 正常**；`MOBILE_IN_BLACK` = 号码在黑名单（阿里云侧，多为测试号）|
| `details[].receiveDate` | 实际送达时间，**空 = 未送达** |
| `details[].content` | 实际下发的短信正文（含签名），可用来核对变量替换是否正确 |

> 💡 **排障技巧**：测试号 `13000000000` 常返回 `MOBILE_IN_BLACK`（阿里云黑名单），
> 这是号码问题**不是**你的接口问题。要验证真实送达请用真实号码。

---

### 10.7 固定参数模式配置项

`.env`（`/var/www/TideSail/.env`）：

| 变量 | 当前值 | 说明 |
| --- | --- | --- |
| `SMS_GATEWAY_ALLOW_SIMPLE_TOKEN` | `1` | 总开关，`1` 才启用本模式 |
| `SMS_GATEWAY_FIXED_TOKEN` | 64 位 hex | 固定 token，**等同密码** |
| `SMS_GATEWAY_FIXED_TEMPLATE_CODES` | `SMS_512081074` | 模板白名单，逗号分隔 |
| `SMS_GATEWAY_RATE_PER_MIN` | `10` | 每分钟上限（0 = 不限）|
| `SMS_GATEWAY_RATE_PER_DAY` | `200` | 每天上限（0 = 不限）|
| `SMS_IDEMPOTENCY_TTL_MS` | `86400000` | 幂等缓存时长（24h）|
| `SMS_IDEMPOTENCY_MAX` | `5000` | 幂等缓存条数上限 |

改完需 `pm2 restart tidesail --update-env` 生效。

固定 token 明文备份：`/root/sms_gateway_fixed_token.txt`（权限 600）

> ⚠️ **token 轮换步骤**：`openssl rand -hex 32` 生成新值 → 改 `.env` →
> `pm2 restart tidesail --update-env` → 同步更新钉钉侧常量。
> 一旦怀疑泄露，立刻轮换（泄露后无鉴权上限，会烧钱）。

---

### 10.8 钉钉侧接入清单

1. **通道选型**：钉钉自定义机器人只能发固定 HTTP 请求 → 用本模式（不走 HMAC）。
2. **域名**：填 `https://xigouoa.xyz/api/sms/send`，**不要用 IP 直连**（token 明文裸奔）。
3. **固定常量**：`X-SMS-Token` 写死在钉钉侧配置里。
4. **姓名**：`templateParam.name` 必须是**真名式 2~4 个中文字**（见 10.5 变量校验坑）。
   若钉钉字段是英文名/工号，需先转换，否则发送失败。
5. **幂等键**：`requestId` 用 `join-{钉钉userid}`，**必须是稳定值**。
6. **错误处理**：区分 4 类——
   - `401 SMS_AUTH_BAD_TOKEN` → token 配错，查钉钉侧常量
   - `403 SMS_TEMPLATE_NOT_ALLOWED` → 模板不在白名单
   - `429 SMS_RATE_LIMIT_*` → 触发限流，需告警（可能是滥用信号）
   - `502 isv.TEMPLATE_PARAMS_ILLEGAL` → 姓名格式不合规范

---

### 10.9 已验证项（2026-09-26 实测）

| 项 | 结果 |
| --- | --- |
| 域名 + HTTPS 完整链路 | ✅ `HTTP 200`，`bizId=739308190414075724^0`，耗时 0.47s |
| DNS | ✅ `xigouoa.xyz → 42.193.159.241` |
| TLS 证书 | ✅ Let's Encrypt，`CN=xigouoa.xyz`，到期 2026-12-25 |
| 固定 token 正确 | ✅ 200 |
| 固定 token 错误 | ✅ 401 `SMS_AUTH_BAD_TOKEN` |
| 无鉴权头 | ✅ 401 `SMS_AUTH_MISSING` |
| 白名单外模板 | ✅ 403 `SMS_TEMPLATE_NOT_ALLOWED` |
| 非法手机号 | ✅ 400 `SMS_PHONE_INVALID` |
| 幂等（同 requestId ×2） | ✅ 相同 `bizId`，带 `idempotent:true` |
| 限流（连打 14 次） | ✅ 通过 5 / 429 限流 9 |
| HMAC 老路径不受影响 | ✅ 回归 `pass=18 fail=0` |
