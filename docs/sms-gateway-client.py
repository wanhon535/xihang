#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汐构短信网关 —— Python 调用示例 / 参考实现
============================================
服务名：xigou-sms-gateway
用途：外部系统（如钉钉人员加入流程）触发短信发送

依赖：仅标准库（requests 可选，本文件用 urllib 保证零依赖）
Python 版本：3.7+

使用前只需替换下面两处：
    GATEWAY_URL  = "http://42.193.159.241:9988"      # 汐航站点地址（或 https://xigouoa.xyz）
    KEY_ID       = "xigou"
    KEY_SECRET   = "1595a933..."                     # 管理员给的固定密钥
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.request

# ============================ 配置区 ============================
GATEWAY_URL = "http://42.193.159.241:9988"
KEY_ID = "xigou"
KEY_SECRET = "1595a9331928bb318537947e97fe5173816f88299ddd9e05e0c5c46aa1e7a4a7"

# 固定的接口路径（签名计算要用，不要改）
SEND_PATH = "/api/sms/send"
# 允许的最大时间偏差（秒），与服务端一致，默认 300
MAX_SKEW_SECONDS = 300
# ==============================================================


class SmsGatewayError(Exception):
    """网关返回的业务错误"""

    def __init__(self, status, code, message, payload=None):
        super().__init__(f"[{status}] {code}: {message}")
        self.status = status
        self.code = code
        self.message = message
        self.payload = payload or {}


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _build_signature(method: str, path: str, timestamp: int, nonce: str, raw_body: str) -> str:
    """
    待签名字符串（5 行，用 \n 连接，顺序不能变）：
        METHOD
        PATH
        TIMESTAMP
        NONCE
        SHA256_HEX(RAW_BODY)      # 空 body 则为 sha256("") 的值

    算法：HMAC-SHA256(secret, string_to_sign)  ->  小写十六进制
    """
    string_to_sign = "\n".join([
        method.upper(),
        path,
        str(timestamp),
        nonce,
        _sha256_hex(raw_body),
    ])
    return hmac.new(
        KEY_SECRET.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def send_sms(
    phone,
    template_code=None,
    template_param=None,
    content=None,
    sign_name=None,
    request_id=None,
    timeout=10,
):
    """
    触发一条短信。

    :param phone:         手机号。字符串或列表；支持 +86 / 空格 / 连字符，服务端会清洗
    :param template_code: 模板 Code，如 "SMS_512081074"。不传则用服务端默认模板
    :param template_param:模板变量 dict。注意键名不要带 ${}，
                          例如 {"name": "张三"} 对应模板 ${name}
    :param content:       仅当服务端默认模板是「自定义内容」时使用
    :param sign_name:     签名，不传则用服务端默认签名
    :param request_id:    幂等键。同一 request_id 重复提交不会重复发送。
                          不传则自动生成（自动生成时无幂等保护）
    :return: dict —— 网关原始响应 {"ok": True, "data": {...}}
    :raises SmsGatewayError: 鉴权失败 / 参数错误 / 发送失败
    """
    # 1) 手机号统一转成列表
    if isinstance(phone, str):
        phones = [phone]
    else:
        phones = list(phone)

    # 2) 组装 body
    body = {"phone": phones}
    if template_code:
        body["templateCode"] = template_code
    if template_param:
        body["templateParam"] = template_param
    if content:
        body["content"] = content
    if sign_name:
        body["signName"] = sign_name
    if request_id:
        body["requestId"] = request_id

    # 3) 关键：序列化一次，签名和发送必须用同一个字符串
    #    分隔符固定为 (",", ":")，不加空格 —— 与 Python 默认输出一致
    raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    body_bytes = raw_body.encode("utf-8")

    # 4) 生成鉴权头
    timestamp = int(time.time())
    nonce = secrets.token_hex(12)  # 24 位十六进制，每次请求必须唯一
    signature = _build_signature("POST", SEND_PATH, timestamp, nonce, raw_body)

    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "X-SMS-Key": KEY_ID,
        "X-SMS-Timestamp": str(timestamp),
        "X-SMS-Nonce": nonce,
        "X-SMS-Signature": signature,
    }

    # 5) 发送
    req = urllib.request.Request(
        GATEWAY_URL.rstrip("/") + SEND_PATH,
        data=body_bytes,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"raw": raw}
        raise SmsGatewayError(
            e.code,
            payload.get("code", "HTTP_ERROR"),
            payload.get("message", raw[:200]),
            payload,
        ) from None


def health(timeout=5):
    """探活。无需鉴权。"""
    req = urllib.request.Request(GATEWAY_URL.rstrip("/") + "/api/sms/health", method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ============================ 使用示例 ============================
if __name__ == "__main__":
    # 0) 先探活
    print("health:", health())

    # 1) 最简：用服务端默认模板发一条
    # print(send_sms("13800138000", request_id="test-001"))

    # 2) 指定模板 + 变量（欢迎新人）
    # print(send_sms(
    #     "13800138000",
    #     template_code="SMS_512081074",
    #     template_param={"name": "张三"},
    #     request_id="welcome-zhangsan-20260926",
    # ))

    # 3) 批量发送
    # print(send_sms(["13800138000", "13900139000"], template_param={"name": "李四"}))

    # 4) 错误处理范式
    # try:
    #     send_sms("12345")
    # except SmsGatewayError as e:
    #     print("发送失败:", e.status, e.code, e.message)
    pass
