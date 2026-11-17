# 单据识别与分类 API(v2)

把一张单据图片(收据、发票、销售订单、报价单、送货单、贷项通知单……)发过来,服务用 Claude Haiku 5.5 **判断它是什么单据**,
读出全部字段(抬头、开单方和对方、金额、税、商品行),做金额对账,并**自己生成标题和关键词**,以固定的 JSON 返回。
同时这张单据进入门户的「待审核」队列,供人工复核。

- 协议: HTTP,JSON 响应。v2 的接口都在 `/v2/` 下。**`/v1/*` 保持不变**(文档见 [API-v1.md](API-v1.md)),已经在联调的调用方不受影响。
- 认证: `Authorization: Bearer <口令>`(`x-token: <口令>` 头也认)。POST 不需要门户专用的 `x-portal` 头。
- 命名: 对外统一**下划线命名**。图上没印或读不出来的值是 `null`,**绝不编造**。金额一律是数字。
- 同一张图(按内容判断,不看文件名)再传,直接返回已有结果,**不会再调用模型、不会重复入库**。
- JSON 结构的机器可读定义: [openapi.yaml](openapi.yaml) 和 [shared/schema/document-v2.schema.json](shared/schema/document-v2.schema.json)(两份由测试保证一致)。

> **请从你们的后端调用,不要让浏览器前端直接调。** 口令会暴露给用户,图片也会发给 Anthropic。本服务没有开 CORS。
> 用户拖拽发票 → 你们的前端把图片传给你们的后端 → 你们的后端调用本 API。

## 1. 部署与配置

```powershell
cd D:\ai-video-generation-model\receipt-portal-autocount
$env:ANTHROPIC_API_KEY = "<Anthropic 密钥,只放环境变量>"
$env:OUR_COMPANY_NAMES = "你们公司名|公司别名"      # 可选,见第 6 节
bun run build
bun run start --host 0.0.0.0 --port 8082 --token <给对方系统的口令>
```

- 让别的机器访问必须用 `--host 0.0.0.0`,此时**必须**设 `--token`,不设程序会拒绝启动。只在本机测试可以不加(默认只监听 127.0.0.1,不需要口令)。
- 对外要走公网时,请放在你们自己的 HTTPS 反向代理后面。本服务自己不提供 HTTPS。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (必填) | 没设时扫描关闭,`/v2/scan` 返回 503,其余接口照常 |
| `CLAUDE_CLASSIFY` | 开 | 设 `0` 回到「只读收据字段」,没有分类 |
| `OUR_COMPANY_NAMES` / `OUR_COMPANY_REG_NOS` / `OUR_COMPANY_TAX_IDS` | 不配置 | 「我方身份」,多个值用 `\|` 隔开。**可选**,用来判断单据是我们开出去的还是别人开给我们的 |
| `CLASSIFY_TRUSTED_TYPES` | `receipt` | 分类结果被信任到「可以自动放行」的类型(逗号分隔)。其余类型没有真实样本验证过,一律转人工 |
| `CLASSIFY_MIN_CONFIDENCE` | `0.8` | 模型把握度低于它就转人工(占位值,要用真实样本标定) |
| `CLAUDE_FULLTEXT` | 开 | 多读一次整页转写,用来核对金额和分类证据。设 `0` 省一次调用,但失去交叉验证 |

## 2. 接口一览

| 接口 | 用途 |
|---|---|
| `GET /v2/health` | 联调: 地址通不通、口令对不对、扫描 / 分类开着没有、我方身份配置了没有。不调用模型,不花钱 |
| `GET /v2/types` | 当前有哪些单据类型、各自的字段要求、能不能写入 AutoCount |
| `POST /v2/scan` | 识别一张单据,返回 `{ scan, receipt }` |
| `GET /v2/receipts/{id}` | 取一张单据的**最新**结构(人工复核改过的内容会体现在里面) |
| `GET /v2/receipts` | 列表与搜索: 按类型、方向、关键词、日期、审核状态筛选,分页 |

## 3. `GET /v2/health`

```bash
curl -H "Authorization: Bearer <口令>" http://<服务器>:8082/v2/health
```

```json
{
  "ok": true,
  "scan_enabled": true,
  "provider": "claude-haiku-5-5",
  "classify_enabled": true,
  "max_image_bytes": 31457280,
  "schema_version": "2.0",
  "our_company_configured": true,
  "trusted_types": ["receipt"],
  "min_confidence": 0.8
}
```

`scan_enabled: false` = 服务器没设 `ANTHROPIC_API_KEY`。`our_company_configured: false` = 发票的方向会是 `unknown`(见第 6 节)。

## 4. `GET /v2/types`

返回全部 9 个类型。调用方可以动态读取,不用写死。每个类型:

| 字段 | 含义 |
|---|---|
| `id` | `receipt` · `invoice` · `sales_invoice` · `purchase_invoice` · `sales_order` · `quotation` · `delivery_order` · `credit_note` · `other` |
| `label` | `{zh, en}` 名称 |
| `default_direction` | 没有「我方身份」时能默认的方向;`null` = 不能默认 |
| `needs` | 这个类型对 `doc_no / counterparty / amounts / line_items / payment` 的要求: `required` / `recommended` / `optional` / `none` |
| `reconcile_amounts` | 是否做金额对账(送货单不做) |
| `postable` | 能不能写入 AutoCount。`invoice`(方向未定)和 `other` 不能 |
| `model_outputs` | `true` = 模型直接输出这个类型;`false` = 由代码按方向从 `invoice` 落成(`sales_invoice` / `purchase_invoice`) |
| `autocount` | 按方向的 AutoCount 目标: `{entity, code, party_role, post_as, verified}`。`verified: false` 表示字段要求还没用 AutoCount 核对过 |

**为什么有 `invoice` 这个类型**: 销售发票和采购发票在图上长得一模一样(都印 TAX INVOICE),看图分不出来。所以模型只判断「这是发票」,
是销售还是采购由服务按「我方身份」决定。没配置我方身份时保持 `invoice`(方向未定),**不硬猜**。

## 5. `POST /v2/scan`

**请求体就是图片的原始字节**(不是 multipart 表单,不要 base64)。

| 位置 | 名称 | 必填 | 说明 |
|---|---|---|---|
| query | `file` | 是 | 文件名,**必须带扩展名**: jpg / jpeg / png / webp / gif。最长 200 字符 |
| query | `batch` | 否 | 批次名,最长 60 字符。不给就是 `api 时间` |
| query | `hint_type` | 否 | 你们已经知道类型时直接指定(例如用户在界面上选了「销售订单」),见下 |
| header | `Authorization` | 设了口令时必填 | `Bearer <口令>` |
| header | `x-lang` | 否 | `en` 时错误信息返回英文,默认中文。**程序请用 `code` 判断,不要解析 `error` 文字** |

图片上限 30 MB,服务会在发给模型前自动缩小。**PDF 暂不支持**,请先转成图片。

```bash
curl -X POST "http://<服务器>:8082/v2/scan?file=iv-2001.jpg" \
  -H "Authorization: Bearer <口令>" \
  --data-binary "@iv-2001.jpg"
```

### `hint_type`

- 以你们指定的为准,模型自己的判断留作候选(`classification.alternatives`),并加原因代码 `type_hinted`(和模型不一样时再加 `type_hint_differs`)。
- **跳过的只是模型的把握度和证据检查**(那是模型推断出来的)。其余检查照旧: 没验证过的类型仍然转人工、日期和证件号检查、类型与内容矛盾检查。
- 指定 `sales_invoice` / `purchase_invoice` 时,方向跟着类型走。如果和「我方身份」判出来的方向矛盾,按你们指定的走,但标 `type_conflict` 并转人工。
- 不认识的类型 → `422 TYPE_NOT_ENABLED`,不会调用模型。
- 这张图以前传过(重复)时,返回已入库的结果,`hint_type` 不会改动它。
- 只有分类开着(`classify_enabled: true`)时才有意义。

### 响应 `200`

`scan` 是这次扫描的摘要,`receipt` 是完整结构。以下是真实代码生成的响应(`receipt.reconciliation.checks` 只留了一项):

```json
{
  "scan": {
    "file": "iv-2001.jpg",
    "id": 1,
    "duplicate": false,
    "status": "REVIEW",
    "reasons": ["scanned_in_portal", "type_unverified"],
    "ms": 5,
    "merchant": "XYZ SDN BHD",
    "total": 1060,
    "currency": "MYR",
    "items": 1,
    "document_type": "sales_invoice",
    "direction": "sales",
    "title": "XYZ SDN BHD invoice IV-2001 (2026-11-10)"
  },
  "receipt": {
    "schema_version": "2.0",
    "id": 1,
    "file": "iv-2001.jpg",
    "classification": {
      "document_type": "sales_invoice",
      "autocount_doc_type": "IV",
      "direction": "sales",
      "confidence": 0.96,
      "alternatives": [{ "document_type": "receipt", "confidence": 0.03 }],
      "evidence": ["TAX INVOICE", "Bill To"],
      "title_printed": "TAX INVOICE",
      "type_verdict": "unverified"
    },
    "title": "XYZ SDN BHD invoice IV-2001 (2026-11-10)",
    "keywords": ["xyz sdn bhd", "iv-2001", "a4 paper", "net 30"],
    "language": "en",
    "header": {
      "doc_no": "IV-2001", "doc_date": "2026-11-10", "due_date": "2026-12-10", "valid_until": null, "currency": "MYR",
      "reference": null, "customer_po_no": "PO-7001", "terms": "Net 30", "supplier_invoice_no": null, "delivery_address": null
    },
    "parties": {
      "issuer": { "name_as_printed": "OUR TRADING SDN BHD", "name_normalized": "OUR TRADING", "reg_no": "201901000001", "tax_id": "000123456789", "address": "12 Jalan Maju, 50000 Kuala Lumpur", "phone": null, "email": null },
      "counterparty": { "name_as_printed": "XYZ SDN BHD", "name_normalized": "XYZ", "reg_no": null, "tax_id": null, "address": "8 Jalan Damai, 47500 Subang Jaya", "phone": null, "email": null }
    },
    "amounts": { "subtotal": 1000, "discount": null, "service_charge": null, "tax": 60, "tip": null, "fees": null, "rounding": null, "total": 1060, "paid": null, "change": null, "outstanding": null },
    "taxes": [{ "label": null, "rate": null, "base": null, "amount": 60 }],
    "line_items": [{ "line_no": 1, "description": "A4 PAPER 80GSM", "item_code_printed": null, "quantity": 10, "uom": "BOX", "unit_price": 100, "discount": null, "tax_rate": null, "total_price": 1000 }],
    "payment": { "method": null, "reference": null, "card_last4": null },
    "relations": { "original_invoice_no": null, "related_po_no": null, "related_so_no": null, "related_do_no": null, "reason": null },
    "autocount_hint": { "entity": "sales.invoice", "party_role": "debtor", "party_name_as_printed": "XYZ SDN BHD", "needs_master_match": true, "post_as": "document" },
    "reconciliation": { "mode": "exclusive", "has_failure": false, "checks": [{ "id": "total_formula", "status": "ok", "params": { "mode": "exclusive", "expected": 1060, "total": 1060, "diff": 0 } }], "suggestions": [], "flags": [] },
    "quality": { "verdict": "REVIEW", "type_verdict": "unverified", "needs_review": true, "reasons": ["scanned_in_portal", "type_unverified"], "needs_review_reasons": ["type_unverified"] },
    "review": { "state": "pending", "reviewed_by": null, "reviewed_at": null, "human_edited_fields": [] },
    "untrusted_text_fields": ["title", "keywords[]", "classification.evidence[]", "classification.title_printed", "header.reference", "header.terms", "header.delivery_address", "parties.*.name_as_printed", "parties.*.address", "relations.reason", "line_items[].description"],
    "warnings": []
  }
}
```

关键字段说明:

| 字段 | 含义 |
|---|---|
| `classification.document_type` | 单据类型。`null` = 没分类过(只会出现在旧数据里) |
| `classification.autocount_doc_type` | AutoCount 单据代码(IV / PI / SO …)。由映射表得出,**不是模型填的**;方向未知或不能写入时为 `null` |
| `classification.direction` | `sales`(我们是开单方)/ `purchase`(我们是收单方)/ `unknown`。由代码按「我方身份」判定 |
| `classification.confidence` | 模型的把握度 0–1。`hint_type` 指定的为 1 |
| `classification.evidence` | 图上印的、支持这个判断的原文片段,**已核对确实出现在整页转写里**(编造的会被去掉) |
| `title` | 一句话标题,≤ 80 字符,不含金额、电话、邮箱、长数字 |
| `keywords` | 最多 10 个,小写,不含金额和证件号 |
| `parties.issuer` / `parties.counterparty` | 开单方 / 对方,按单据上印的原文。**不管方向有没有判出来都会给** |
| `scan.merchant` | 「对方」: 销售类是客户,其余是开单方 / 商家 |
| `line_items[].total_price` | 行金额 = 数量 × 单价 − 折扣(净额,税另算) |
| `autocount_hint` | 只是建议,**不会写入任何东西**。`post_as`: `document` = 带商品行的单据,`cash_book_voucher` = 现金账凭证,`none` = 不写入 |

## 6. 方向与「我方身份」

图片上没有「我们是谁」,所以单据是我们开出去的还是别人开给我们的,只能靠配置。**配置是可选的**:

- **没配置**: 收据默认是采购(我们花钱);订单、报价单默认是销售;**发票、送货单、贷项通知单的方向是 `unknown`**(发票停在 `invoice`)。
  但开单方和对方(`parties`)照常精确输出,你们自己知道自己是谁,可以自己判断。
- **配置了**(`OUR_COMPANY_NAMES` / `_REG_NOS` / `_TAX_IDS`): 开单方是我们 → `sales`;对方是我们 → `purchase`;
  两边都不是或都是 → 仍然 `unknown`,不猜。名字匹配不看大小写、标点和 SDN BHD 这类后缀;税号、注册号精确匹配优先。
- 收据 + 开单方是我们 = 现金销售(AutoCount 的 `sales.cash_sale`)。

## 7. 怎么判断「能不能直接用」

**看 `receipt.quality.verdict` 和 `receipt.classification.type_verdict`,不要只看 `needs_review`。**

| `quality.verdict` | 含义 | 建议 |
|---|---|---|
| `AUTO_VERIFIED` / `AUTO` | 字段齐全,金额互相印证,分类可信 | 可以直接用 |
| `CORRECTED` | 有字段被规则自动更正过 | 可用,建议抽查 |
| `PARTIAL` | 只读到一部分 | 需要人工补 |
| `REVIEW` | 对不上 / 有疑点 / 分类没验证过 | **不要直接用**,等人工复核 |

**目前只有收据的分类被信任到可以自动放行。其余类型(发票、订单、报价单、送货单、贷项通知单)没有真实样本验证过,一律是 `REVIEW`**,
带原因代码 `type_unverified`。样本到位、标定之后才会逐类放宽。`needs_review: true` 只表示「还没有人工确认」,不等于有问题。

`classification.type_verdict`:

| 值 | 含义 |
|---|---|
| `ok` | 可信 |
| `unverified` | 没验证过的类型 / 没有整页转写没法核对证据 |
| `direction_unknown` | 类型认出来了,但方向没法判断 |
| `low_confidence` | 模型把握度低、第一和第二候选太接近、或是 `other` |
| `evidence_missing` | 模型给的证据在图上找不到(可能是编造) |
| `conflict` | 类型和内容矛盾(例如订单上有实付 / 找零) |
| `unclassified` | 旧数据,没分类过 |

分类相关的原因代码(出现在 `scan.reasons` 和 `quality.reasons`,`quality.needs_review_reasons` 只列分类相关的):

| 代码 | 含义 |
|---|---|
| `type_unverified` | 这个类型还没有被信任(默认只信任收据) |
| `type_low_confidence` | 把握度低 / 候选太接近 / 是 `other` |
| `type_evidence_missing` | 证据在转写里找不到 |
| `type_conflict` | 类型和内容矛盾,或 `hint_type` 和我方身份判出的方向矛盾 |
| `type_unchecked` | 没有整页转写,证据没法核对(只是提示) |
| `type_hinted` / `type_hint_differs` | 类型是调用方指定的 / 和模型的判断不一样 |
| `direction_unknown` | 方向没法判断 |
| `date_gst_era_mismatch` | 单据印着 GST,但日期不在 GST 时期(2015-04 到 2018-12),多半是日期读反了 |
| `date_in_future` / `date_too_old` | 日期晚于今天 3 天以上 / 早于 2000 年 |
| `id_format_suspect` | 税号 / 注册号位数不对(纯数字的必须 12 位),长数字模型会多读或少读一位 |

## 8. `GET /v2/receipts/{id}`

返回和 `/v2/scan` 里 `receipt` 相同的结构,但是**最新**的值: 人工在门户里复核、改过的内容都会体现(`review.state`、`review.human_edited_fields`)。
不含 OCR 原文、图片路径、审核备注。`404 RECEIPT_NOT_FOUND` = 没有这个编号。

## 9. `GET /v2/receipts`(列表与搜索)

| query | 说明 |
|---|---|
| `type` | 单据类型;`none` = 没分类过的。不认识的 → `422 TYPE_NOT_ENABLED` |
| `direction` | `sales` / `purchase` / `unknown`。不合法 → `400 VALIDATION` |
| `state` | 审核状态 `pending` / `approved` / `rejected` / `all`(默认) |
| `q` | 搜索: 文件名、对方名、**标题**、**单据号**、审核人、备注 |
| `from` / `to` | 单据日期范围,`YYYY-MM-DD` |
| `page` / `page_size` | 默认第 1 页、每页 20;每页最多 100 |

```json
{
  "items": [
    {
      "id": 1, "file": "iv-2001.jpg", "title": "XYZ SDN BHD invoice IV-2001 (2026-11-10)",
      "document_type": "sales_invoice", "direction": "sales", "doc_no": "IV-2001", "party": "XYZ SDN BHD",
      "doc_date": "2026-11-10", "currency": "MYR", "total": 1060, "confidence": 0.96,
      "verdict": "REVIEW", "needs_review": true, "review_state": "pending", "imported_at": "2026-11-17T16:16:01"
    }
  ],
  "total": 1, "page": 1, "page_size": 5
}
```

最新的在前,按编号排序,翻页稳定。**不合法的筛选值会报错,不会悄悄当成没传而返回全部数据。** 要看完整结构用 `GET /v2/receipts/{id}`。

## 10. 错误

格式统一: `{ "error": "<说明文字>", "code": "<稳定的错误码>" }`。

| HTTP | `code` | 含义 | 调用方怎么做 |
|---|---|---|---|
| 400 | `IMAGE_EMPTY_OR_TOO_BIG` | 请求体为空或超过 30 MB | 修正后重传 |
| 400 | `IMAGE_UNSUPPORTED` | 扩展名不是 jpg / jpeg / png / webp / gif | **PDF 暂不支持**,先转成图片 |
| 400 | `VALIDATION` | 缺 `file` 参数,或筛选值格式不对 | 修正请求 |
| 401 | `TOKEN_REQUIRED` | 口令缺失或不对 | 检查口令 |
| 404 | `RECEIPT_NOT_FOUND` | 没有这个编号 | — |
| 422 | `TYPE_NOT_ENABLED` | `hint_type` 或列表的 `type` 不认识 | 用 `GET /v2/types` 查可用类型 |
| 429 | `SCAN_RATE_LIMIT` | Anthropic 额度或频率限制 | 指数退避后重试 |
| 502 | `SCAN_AUTH` / `SCAN_NETWORK` / `SCAN_UPSTREAM` | 识别服务出错(密钥错、连不上 Anthropic、上游故障) | 通知运维;后两者可稍后重试。具体原因只写在服务器日志里,不会返回给调用方 |
| 503 | `SCAN_DISABLED` | 服务器没设 `ANTHROPIC_API_KEY` | 通知运维 |
| 504 | `SCAN_TIMEOUT` | 识别超时 | 可重试一次 |

**图片读不出内容(太糊、不是单据)不是错误**: 照样返回 200,单据进入待审核,`verdict` 为 `REVIEW`,类型是 `other`,字段为空,由人工看图填写。
重试是安全的: 同一张图再传不会重复入库、不会重复调用模型(调用失败的那次没有入库)。

## 11. 调用示例(你们的后端)

### Python

```python
import requests

BASE = "http://<服务器>:8082"
TOKEN = "<口令>"          # 放环境变量,不要写死在代码里

def scan_document(path: str, hint_type: str | None = None) -> dict:
    params = {"file": path.replace("\\", "/").split("/")[-1]}     # 必须带扩展名
    if hint_type:
        params["hint_type"] = hint_type
    with open(path, "rb") as f:
        r = requests.post(f"{BASE}/v2/scan", params=params, headers={"Authorization": f"Bearer {TOKEN}"}, data=f.read(), timeout=180)
    if r.status_code == 200:
        return r.json()
    raise RuntimeError(f"{r.status_code} {r.json().get('code')}")      # 用 code 判断,不要解析 error 文字

res = scan_document(r"D:\docs\iv-2001.jpg")
doc = res["receipt"]
if doc["quality"]["verdict"] in ("AUTO_VERIFIED", "AUTO"):
    print("可直接用:", doc["classification"]["document_type"], doc["title"], doc["amounts"]["total"])
else:
    print("需要人工复核:", doc["quality"]["needs_review_reasons"] or doc["quality"]["reasons"])
```

### Node.js(18+)

```js
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE = "http://<服务器>:8082";
const TOKEN = process.env.DOC_API_TOKEN;

export async function scanDocument(path, hintType) {
  const q = new URLSearchParams({ file: basename(path), ...(hintType ? { hint_type: hintType } : {}) });
  const res = await fetch(`${BASE}/v2/scan?${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: await readFile(path),                  // 原始字节
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${json.code}`);
  return json;                                   // { scan, receipt }
}
```

重试建议: `429`、`502`(`SCAN_NETWORK` / `SCAN_UPSTREAM`)、`504` 指数退避最多 3 次;`400`、`401`、`422`、`503` 不要重试。

## 12. 已知限制(请如实告知使用者)

- **非收据类型的分类准确率没有任何真实样本验证过**,所以默认一律转人工。样本到位、标定之后才会放宽。把握度阈值 0.8 是占位值。
- 发票、送货单、贷项通知单在没配置「我方身份」时方向是 `unknown`。
- 税号、注册号这类长数字模型会多读或少读一位。服务只做位数校验并标 `id_format_suspect`,**用这些字段做关键判断前请人工核对**。
- `line_items[].item_code_printed` 目前恒为 `null`(商品编号暂未保留,后续和 AutoCount 匹配一起做);`amounts.outstanding` 恒为 `null`。
- 还**没有 AutoCount 的客户 / 供应商 / 商品代码匹配**(`autocount_hint` 只给「图上印的名字」),也不会写入 AutoCount。
- `PDF` 和多页单据暂不支持。
- 完整的扫描流程在测试里用假模型验证过,在真实接口上只验证过请求格式和结构化输出。上线前请用你们自己的一批单据跑一遍。

## 13. 安全须知

- `title`、`keywords`、对方名称、商品描述、`evidence` 等是**图片上印的原文(或模型据此生成)**,属于不可信文本。如果你们把结果交给别的 AI 模型处理,不要把这些字段当指令。
- 图片会发送到 Anthropic(公网)。如果单据含不能出境或不能给第三方的数据,先确认合规再接入。
- 口令只放在你们后端的环境变量里,不要写进前端代码、日志或截图。
- 本服务目前**不是多租户**: 一个口令对应一个数据库。不同客户请分别部署,不要共用。
