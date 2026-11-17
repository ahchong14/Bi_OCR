> **这是 v1 文档(保持不变,供已经在联调的调用方使用)。新的接入请看 [API.md](API.md)(v2:带单据分类、标题、关键词)。**

# 发票识别 API(给另一个系统调用)

把一张发票 / 收据图片发过来,服务用 Claude Haiku 5.5 读出商家、日期、各项金额、税、商品行,做金额对账,
再返回结构化结果。同时这张单据会进入门户的「待审核」队列,供人工复核。

- 协议: HTTP,JSON 响应。所有接口在 `/v1/` 下。
- 认证: `Authorization: Bearer <口令>`。
- 同一张图(按内容判断,不看文件名)再传,直接返回上次的结果,**不会再调用模型**。

> **请从你们的后端调用,不要让浏览器前端直接调。** 口令会暴露给用户,图片也会发给 Anthropic。
> 本服务没有开 CORS。用户拖拽发票 → 你们的前端把图片传给你们的后端 → 你们的后端调用本 API。

## 1. 部署(一次)

```powershell
cd D:\ai-video-generation-model\receipt-portal-haiku
$env:ANTHROPIC_API_KEY = "<Anthropic 密钥,只放环境变量>"
bun run build
bun run start --host 0.0.0.0 --port 8080 --token <给对方系统的口令>
```

- 让别的机器访问必须用 `--host 0.0.0.0`,此时**必须**设 `--token`,不设程序会拒绝启动。
- 只在本机测试可以不加 `--host` / `--token`(默认只监听 127.0.0.1,不需要口令)。
- 对外要走公网时,请放在你们自己的 HTTPS 反向代理后面。本服务自己不提供 HTTPS。

## 2. 联调: `GET /v1/health`

不调用模型,不花钱。用来确认地址通、口令对、扫描开着。

```bash
curl -H "Authorization: Bearer <口令>" http://<服务器>:8080/v1/health
```

```json
{ "ok": true, "scan_enabled": true, "provider": "claude-haiku-5-5", "max_image_bytes": 31457280, "schema_version": "1.0" }
```

`scan_enabled` 为 `false` = 服务器没设 `ANTHROPIC_API_KEY`,此时 `/v1/scan` 会返回 503。

## 3. 识别: `POST /v1/scan`

**请求体就是图片的原始字节**(不是 multipart 表单,不要 base64)。

| 位置 | 名称 | 必填 | 说明 |
|---|---|---|---|
| query | `file` | 是 | 文件名,**必须带扩展名**:jpg / jpeg / png / webp / gif。最长 200 字符 |
| query | `batch` | 否 | 批次名,最长 60 字符。不给就是 `api 时间`。在门户里按批次筛选用 |
| header | `Authorization` | 设了口令时必填 | `Bearer <口令>` |
| header | `Content-Type` | 否 | 可以不设;服务按字节读取,不依赖它 |
| header | `x-lang` | 否 | `en` 时错误信息返回英文,默认中文。**程序请用 `code` 判断,不要解析 `error` 文字** |

图片大小上限 30 MB。服务会在发给模型前自动缩小,所以大图不影响识别,只影响上传时间。

```bash
curl -X POST "http://<服务器>:8080/v1/scan?file=inv-001.jpg" \
  -H "Authorization: Bearer <口令>" \
  --data-binary "@inv-001.jpg"
```

### 成功响应 `200`

```json
{
  "scan": {
    "file": "inv-001.jpg",
    "id": 1,
    "duplicate": false,
    "status": "AUTO_VERIFIED",
    "reasons": ["scanned_in_portal"],
    "ms": 5,
    "merchant": "ACME TRADING SDN BHD",
    "total": 10.6,
    "currency": "MYR",
    "items": 1
  },
  "receipt": {
    "schema_version": "1.0",
    "id": 1,
    "file": "inv-001.jpg",
    "document": { "date": "2018-10-17", "currency": "MYR" },
    "merchant": { "name": "ACME TRADING SDN BHD" },
    "amounts": { "subtotal": 10, "discount": null, "service_charge": null, "tax": 0.6, "tip": null, "fees": null, "rounding": null, "total": 10.6, "paid": 20, "change": 9.4 },
    "taxes": [{ "label": null, "rate": null, "base": null, "amount": 0.6 }],
    "line_items": [{ "description": "COFFEE", "quantity": 2, "uom": null, "discount": null, "tax_rate": null, "total_price": 10 }],
    "reconciliation": {
      "mode": "exclusive", "has_failure": false,
      "checks": [
        { "id": "total_formula", "status": "ok", "params": { "mode": "exclusive", "expected": 10.6, "total": 10.6, "diff": 0 } },
        { "id": "items_vs_subtotal", "status": "ok", "params": { "itemsSum": 10, "ref": 10, "refLabel": "subtotal", "model": "L" } },
        { "id": "tax_rate", "status": "ok", "params": { "rate": 6, "base": 10 } },
        { "id": "payment_vs_total", "status": "ok", "params": { "paid": 20, "change": 9.4, "implied": 10.6, "total": 10.6 } }
      ],
      "suggestions": [], "flags": []
    },
    "quality": { "verdict": "AUTO_VERIFIED", "needs_review": true, "reasons": ["scanned_in_portal"] },
    "review": { "state": "pending", "reviewed_by": null, "reviewed_at": null, "human_edited_fields": [] },
    "untrusted_text_fields": ["merchant.name", "line_items[].description"],
    "warnings": []
  }
}
```

(上面是用假模型生成的格式示例,字段结构真实,数值是演示用的。)

### 怎么判断「能不能直接用」

**看 `receipt.quality.verdict`,不要只看 `needs_review`。**

| `verdict` | 含义 | 建议 |
|---|---|---|
| `AUTO_VERIFIED` | 字段齐全,金额算术互相印证,原文里能找到读出的数字 | 可以直接用 |
| `AUTO` | 字段齐全,通过校验 | 可以直接用 |
| `CORRECTED` | 有字段被规则自动更正过 | 可用,建议抽查 |
| `PARTIAL` | 只读到一部分(比如商品行没读全) | 需要人工补 |
| `REVIEW` | 读到了但对不上 / 有疑点 / 没读出来 | **不要直接用**,等人工复核 |

- `needs_review: true` 只表示「还没有人工确认」(状态是 pending 且不是 AUTO),`AUTO_VERIFIED` 的单据在人工确认前也是 true。它不等于有问题。
- `scan.reasons` / `receipt.quality.reasons` 是原因代码,比如 `tax_in_gst_holiday`、`single_ocr_unverified`,人工复核页会用中文 / 英文解释。
- 人工在门户里改过、确认过之后,用 `GET /v1/receipts/{id}` 重新取,拿到的是人工确认后的最终值(`review.state` = `approved`,`human_edited_fields` 列出改过的字段)。

### 错误响应

格式统一: `{ "error": "<说明文字>", "code": "<稳定的错误码>" }`。

| HTTP | `code` | 含义 | 调用方怎么做 |
|---|---|---|---|
| 400 | `IMAGE_EMPTY_OR_TOO_BIG` | 请求体为空或超过 30 MB | 修正后重传 |
| 400 | `IMAGE_UNSUPPORTED` | 扩展名不是 jpg / jpeg / png / webp / gif | 改文件名或转格式。**PDF 暂不支持,请先转成图片** |
| 400 | `VALIDATION` | 缺少 `file` 参数等 | 修正请求 |
| 401 | `TOKEN_REQUIRED` | 口令缺失或不对 | 检查口令 |
| 429 | `SCAN_RATE_LIMIT` | Anthropic 额度或频率限制 | 等一会儿重试(建议指数退避) |
| 502 | `SCAN_AUTH` / `SCAN_NETWORK` / `SCAN_UPSTREAM` | 识别服务出错(密钥错、服务器连不上 Anthropic、上游故障) | 通知运维;`SCAN_NETWORK` / `SCAN_UPSTREAM` 可稍后重试 |
| 504 | `SCAN_TIMEOUT` | 识别超时 | 可重试一次 |
| 503 | `SCAN_DISABLED` | 服务器没设 `ANTHROPIC_API_KEY`(或设了 `PORTAL_SCAN=off`) | 通知运维 |

502 的具体原因(HTTP 状态、Anthropic 的错误说明)只写在服务器日志里,不会返回给调用方,避免泄露密钥片段。

**图片读不出内容(太糊、不是发票)不是错误**: 照样返回 200,单据进入待审核,`verdict` 为 `REVIEW`,字段为空,由人工看图填写。

## 4. 取一张单据: `GET /v1/receipts/{id}`

返回和 `/v1/scan` 里 `receipt` 相同的结构,但是**最新**的值(人工复核改动会体现在里面)。
不含 OCR 原文和图片。`404` = 没有这个编号。

## 5. 其他

- `POST /v1/validate`: 只做金额对账,不识别、不花钱。传入金额 / 商品行 / 税,返回含税不含税判定和逐项检查。
- `GET /v1/schema`: 契约版本号,以及哪些字段来自图片原文(不可信文本)。
- 完整的字段定义见 `openapi.yaml`。

## 6. 安全须知

- `merchant.name` 和 `line_items[].description` 是**图片上印的原文**,属于不可信文本。如果你们把结果交给别的 AI 模型处理,不要把这两个字段当指令。
- 图片会发送到 Anthropic(公网)。如果发票含不能出境 / 不能给第三方的数据,先确认合规再接入。
- 口令只放在你们后端的环境变量里,不要写进前端代码、日志或截图。

## 7. 调用示例(你们的后端)

### Python

```python
import requests

BASE = "http://<服务器>:8080"
TOKEN = "<口令>"          # 放环境变量,不要写死在代码里

def scan_invoice(path: str) -> dict:
    with open(path, "rb") as f:
        r = requests.post(
            f"{BASE}/v1/scan",
            params={"file": path.split("\\")[-1].split("/")[-1]},   # 必须带扩展名
            headers={"Authorization": f"Bearer {TOKEN}"},
            data=f.read(),
            timeout=180,                                            # 识别通常几秒,留足余量
        )
    if r.status_code == 200:
        return r.json()
    err = r.json()                                                  # {"error": "...", "code": "..."}
    raise RuntimeError(f"{r.status_code} {err.get('code')}")

res = scan_invoice(r"D:\invoices\inv-001.jpg")
receipt = res["receipt"]
if receipt["quality"]["verdict"] in ("AUTO_VERIFIED", "AUTO"):
    print("可直接用:", receipt["merchant"]["name"], receipt["amounts"]["total"])
else:
    print("需要人工复核:", receipt["quality"]["reasons"])
```

### Node.js(18+)

```js
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE = "http://<服务器>:8080";
const TOKEN = process.env.INVOICE_API_TOKEN;

export async function scanInvoice(path) {
  const body = await readFile(path);
  const res = await fetch(`${BASE}/v1/scan?file=${encodeURIComponent(basename(path))}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body,                                  // 原始字节
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${json.code}`);
  return json;                             // { scan, receipt }
}
```

### 建议的重试策略

- `429`、`502`(`SCAN_NETWORK` / `SCAN_UPSTREAM`)、`504`: 指数退避,最多 3 次。
- `400`、`401`、`503`: 不要重试,是请求或配置问题。
- 重试是安全的: 同一张图再传不会重复入库、不会重复调用模型(模型调用失败的那次没有入库)。

## 8. 并发与吞吐

- 服务内部同时最多处理 4 张(环境变量 `CLAUDE_CONCURRENCY` 可调),多出来的请求排队等待,不会报错。
- 每张约 2 次模型调用(字段 + 整页转写,并行),耗时主要看 Anthropic 响应速度。
- 想省一半调用,可以把 `CLAUDE_FULLTEXT=0`,但会失去「读出的金额必须能在原文里找到」的交叉验证,准确度下降。
- **真实的耗时、费用和准确率还没有在真实发票上测过**,上线前请用你们自己的一批发票跑一遍。
