
import json, sys
d = json.load(sys.stdin)
print("  totalCount:", d.get("totalCount"))
for x in d.get("details", [])[:5]:
    print("  " + x["sendDate"] + "  status=" + str(x["sendStatus"]) + "(" + x["sendStatusText"] + ")")
    print("    " + x["content"])
