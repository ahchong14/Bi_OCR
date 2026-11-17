"""
把 CORD v2 的 parquet(Hugging Face: naver-clova-ix/cord-v2,CC-BY-4.0)转成评测脚本能用的格式:
  receipt data/cord_test/data/cord_0001.jpg ...   图片
  receipt data/cord_test/cord_labels.csv          file,company,date,address,total(总额按「实际金额」写,印尼盾的 60.000 = 60000)
  receipt data/cord_test/cord_extra.json          小计 / 税额 / 付款 / 找零 / 商品行(留给以后测明细)

CORD 的标准答案里【没有】商家名和日期,所以这批只能量化总额(以及 cord_extra.json 里的明细),商家 / 日期不计分。
用法: python eval/convert_cord.py            (需要 pyarrow)
然后: bun eval/run-via-portal.ts --n 100 --seed 21 --include-golden --images "receipt data/cord_test/data" --labels "receipt data/cord_test/cord_labels.csv"
"""
import csv, json, pathlib, re, sys
sys.stdout.reconfigure(encoding="utf-8")
import pyarrow.parquet as pq

root = pathlib.Path(__file__).resolve().parent.parent / "receipt data" / "cord_test"
src = next((root / "raw").glob("test-*.parquet"))
out_img = root / "data"
out_img.mkdir(parents=True, exist_ok=True)

def amount(v):
    """'60.000' / '1,346,000' / '5.50' / 'Rp 12.500' → 数字。末尾分隔符后恰好 3 位 = 千分位(印尼盾没有小数);1~2 位 = 小数。"""
    if v is None: return None
    s = re.sub(r"[^\d.,\-]", "", str(v))
    if not re.search(r"\d", s): return None
    neg = s.startswith("-")
    s = s.lstrip("-")
    m = re.search(r"[.,](\d+)$", s)
    if m and len(m.group(1)) <= 2:
        whole = re.sub(r"[.,]", "", s[: m.start()]) or "0"
        n = float(f"{whole}.{m.group(1)}")
    else:
        n = float(re.sub(r"[.,]", "", s))
    return -n if neg else n

def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""): return d[k]
    return None

t = pq.read_table(src)
rows, extra = [], {}
for i, r in enumerate(t.to_pylist(), 1):
    gt = json.loads(r["ground_truth"]).get("gt_parse", {})
    img = r["image"]
    ext = (pathlib.Path(img.get("path") or "").suffix or ".jpg").lower()
    name = f"cord_{i:04d}{ext}"
    (out_img / name).write_bytes(img["bytes"])
    tot = gt.get("total", {}) if isinstance(gt.get("total"), dict) else (gt.get("total") or [{}])[0]
    sub = gt.get("sub_total", {}) if isinstance(gt.get("sub_total"), dict) else (gt.get("sub_total") or [{}])[0]
    menu = gt.get("menu", [])
    menu = [menu] if isinstance(menu, dict) else (menu or [])
    total = amount(first(tot, "total_price"))
    rows.append([name, "", "", "", "" if total is None else (int(total) if total == int(total) else total)])
    paid = amount(first(tot, "cashprice", "creditcardprice", "emoneyprice"))
    extra[name] = {
        "subtotal": amount(first(sub, "subtotal_price")), "tax": amount(first(sub, "tax_price")),
        "discount": amount(first(sub, "discount_price")), "service": amount(first(sub, "service_price")),
        "paid": paid, "change": amount(first(tot, "changeprice")),
        "items": [{"name": (m.get("nm") if isinstance(m, dict) else None), "qty": amount(m.get("cnt")) if isinstance(m, dict) else None,
                   "price": amount(m.get("price")) if isinstance(m, dict) else None} for m in menu],
    }
with open(root / "cord_labels.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["file", "company", "date", "address", "total"]); w.writerows(rows)
(root / "cord_extra.json").write_text(json.dumps(extra, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(rows)} 张 → {out_img};有总额标签 {sum(1 for r in rows if r[4] != '')} 张")
