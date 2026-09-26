# 汐构短信网关 · 接口文档

**服务名**：`xigou-sms-gateway`
**版本**：1.0.0
**提供方**：汐航后端（TideSail API）
**用途**：外部系统（Python 脚本 / 钉钉人员加入流程 / 任何服务）通过 HTTP 触发短信发送

---

## 1. 接入信息

| 项目 | 值 |
| --- | --- |
| 基础地址（内网） | `http://127.0.0.1:9989` |
| 基础地址（公网） | `http://42.193.159.241:9988`（域名上线后为 `https://xigouoa.xyz`）|
| 短信发送 | `POST /api/sms/send` |
| 探活 | `GET  /api/sms/health`（无需鉴权）|
| 内容类型 | `application/json; charset=utf-8` |
| 鉴权方式 | 固定密钥 + HMAC-SHA256 签名（见第 3 节）|

### 密钥

| 项目 | 值 |
| --- | --- |
| `Key ID` | `xigou` |
| `Key Secret` | `1595a9331928bb318537947e97fe5173816f88299ddd9e05e0c5c46aa1e7a4a7` |

> ⚠️ Secret 等同于密码，请只放在服务端配置里，**不要**写进前端代码或提交到 Git 仓库。
> 服务器上明文备份在 `/root/sms_gateway_secret.txt`（权限 600）。

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

GATEWAY_URL = "http://42.193.159.241:9988"
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
# 探活
curl -s http://42.193.159.241:9988/api/sms/health

# 带签名的发送（用 Python 生成签名最省事，见第 5 节）
```

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

| 模板 Code | 用途 | 变量 |
| --- | --- | --- |
| `SMS_339005026` | 验证码 | `${code}` |
| `SMS_512081074` | 欢迎新人 | `${name}` |

**签名**：`云南汐构信息技术有限公司`（已过审）

新增模板需在阿里云控制台提交审核，通过后把 Code 传给网关即可，无需改代码。
