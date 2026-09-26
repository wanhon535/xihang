
import json, urllib.request, urllib.parse, uuid, os, datetime, hmac, hashlib, base64

AK = os.environ.get("ALIYUN_SMS_ACCESS_KEY_ID") or os.environ["ALIYUN_ACCESS_KEY_ID"]
SK = os.environ.get("ALIYUN_SMS_ACCESS_KEY_SECRET") or os.environ["ALIYUN_ACCESS_KEY_SECRET"]

def rpc(action, extra=None, version="2017-05-25", endpoint="https://dysmsapi.aliyuncs.com/"):
    p = {
        "Format": "JSON", "Version": version, "AccessKeyId": AK, "SignatureMethod": "HMAC-SHA256",
        "Timestamp": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "SignatureVersion": "1.0", "SignatureNonce": str(uuid.uuid4()), "Action": action,
    }
    if extra: p.update(extra)
    def enc(s):
        return urllib.parse.quote(str(s), safe="~")
    qs = "&".join(f"{enc(k)}={enc(p[k])}" for k in sorted(p))
    sts = "POST&" + enc("/") + "&" + enc(qs)
    sig = base64.b64encode(hmac.new((SK+"&").encode(), sts.encode(), hashlib.sha256).digest()).decode()
    body = qs + "&Signature=" + enc(sig)
    req = urllib.request.Request(endpoint, data=body.encode(), headers={"Content-Type":"application/x-www-form-urlencoded"})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())

print("=== 单个模板详情 ===")
for code in ["SMS_512530328","SMS_512081074","SMS_339005026"]:
    d = rpc("GetSmsTemplate", {"TemplateCode": code})
    print(f"  {code}: Status={d.get('TemplateStatus')} Type={d.get('TemplateType')} Reason={d.get('Reason')} Content={d.get('TemplateContent')}")

print()
print("=== 模板列表（QuerySmsTemplateList）===")
r = rpc("QuerySmsTemplateList", {"PageIndex":"1","PageSize":"50"})
print("TotalCount:", r.get("TotalCount"), "| Code:", r.get("Code"), r.get("Message"))
for t in (r.get("SmsTemplateList") or []):
    print("-"*70)
    print(f"  名称: {t.get('TemplateName')}")
    print(f"  Code: {t.get('TemplateCode')}")
    print(f"  类型: {t.get('TemplateType')} (0验证码 1通知 2推广)")
    print(f"  状态: {t.get('TemplateStatus')} (0审核中 1通过 2未通过)")
    print(f"  审核备注: {t.get('Reason')}")
    print(f"  创建: {t.get('CreateDate')}")
    print(f"  内容: {t.get('TemplateContent')}")
