# 实施计划: 单据分类 + v2 JSON + AutoCount 匹配 / 写入

状态: **P0 基本完成、P1 完成、P2 完成、P3 完成**;P4 起尚未开始。适用文件夹: `receipt-portal-autocount`(本副本)。

### 进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 真实接口验证 | **基本完成**(第二轮已跑,结果见下) | 结构化输出可用;跨类型分类的准确率**仍未验证**(只测过零售小票,没有其他类型的真实样本) |
| **P1 合同与存储** | **完成** | 506 个测试全绿(原 467 + 新增 39),服务端和前端类型检查无错 |
| **P2 识别与分类** | **完成** | 622 个测试全绿(原 467 + 新增 155),服务端 / 前端类型检查无错,`/v1` 一行没动。还没有在真实接口上端到端跑过(真实接口只在 P0 测过请求本身);详见下面「P2 实际做了什么」 |
| **P3 公开 API v2** | **完成** | 669 个测试全绿(原 622 + 新增 47),服务端 / 前端类型检查无错,`/v1` 一行没动。新增 `/v2/health`、`/v2/types`、`/v2/scan`(含 `hint_type`)、`/v2/receipts`(列表 / 搜索)、`/v2/receipts/{id}`;文档 `API.md`(v2)、`API-v1.md`(旧)、`openapi.yaml`(v1+v2)。`openapi-drift.test.ts` 保证 OpenAPI、JSON Schema、代码三者一致。**还没用真实密钥端到端跑过 `/v2/scan`**(只用假客户端) |
| ~~P4 AutoCount 匹配~~、~~P6 AutoCount 写入~~ | **不做**(2026-11-17 用户决定) | AutoCount 由对方系统负责;我们只保证**分类正确**和**资料 / 数据正确**。`autocount_hint` 保留为建议字段,不再扩展 |
| P5 界面、P7 加固 | 未开始 | 重点转向 P7: 评估工具、二次读取、低置信度升级;P5 只做审核 / 查看 |

**P0 第一轮真实结果(2026-11-17,`claude-haiku-5-5`,6 张 SROIE 零售小票)**

| 项 | 结果 | 结论 |
|---|---|---|
| 0.1 请求参数 | `thinking: disabled` + `effort: low` 被接受;不传 thinking、不传 effort 也都被接受;带 `temperature` 被 400 拒绝(`Extra inputs are not permitted`),和文档一致 | 线上现在的参数可用,不改 |
| 0.2 结构化输出 | **Schema 被拒绝,但原因是我的 Schema 不合要求,不是功能不可用。** 写法 A: `Enum value 'cash' does not match declared type ['string','null']`;写法 B: `too many parameters with union types (48 ...)` | **重新设计成没有任何可空类型的 Schema**(缺失 = 空字符串,金额用字符串),`docPrompt.ts` 已改并有测试守住(不允许出现 anyOf / type 数组 / 含 null 的 enum)。**第二轮要重新验证** |
| 0.3 长条形收据 | 3 张(高宽比 2.4–2.9,发给模型时 535–667 × 1568):整张读和上下两半合起来读到的**金额数字完全一样** | 金额方面暂时**不需要切分** |
| 0.3 的意外发现 | 同一张小票上同一串 13 位 GST 号,整张读成 `0009886880896`,下半读成 `000986680896`(**两次读出来不一样**)。第一版脚本只比对带小数的金额,没发现 | **长数字(税号 / 注册号 / 单据号)读取不稳定**,P2 必须对它们二次核对或标记「需检查」,不能只信一次。脚本已加入长数字一致性检查 |
| 0.4 / 0.6 | 一次整页转写: 耗时中位数 2.1 秒,输入约 1440 / 输出约 500 token,约 $0.0004;一张图约占 1500 输入 token | 分类这一步的耗时和费用第一轮没测到,等第二轮 |
| 0.5 分类烟雾测试 | **没跑成**(依赖 0.2) | 第二轮 |

**P0 第二轮真实结果(2026-11-17,同样 6 张小票,同一条命令跑了两次)与核对**

对照数据集自带的标准答案(商家 / 日期 / 总额)逐张核对,并把两次运行互相比:

| 指标 | 运行 1 | 运行 2 |
|---|---|---|
| 商家 | 6/6 | 6/6 |
| 日期 | 5/6 | 5/6(同一张错,两次读得一模一样) |
| 总额 | 5/6 | 6/6(同一张图,总额一次读 10.00、一次读 9.00) |
| 两次运行的字段差异 | 6 张 × 十几个字段里只有 3 处不同(2 处是把握度的小数,1 处是上面那个总额) | |

结构化输出: 6/6 解析成功且完全符合 Schema(**采用**);仅提示词对照 0/4(原因未知,脚本已补诊断,**不影响决定**,但说明不能依赖仅提示词路径,`cleanDoc` 必须宽松: 把 null / 数字也当作「没印」「字符串」处理)。耗时: 分类 + 字段中位数约 4 秒(个别 7.7 秒),转写约 2 秒,两者并行;费用: 分类 + 字段 ≈ $0.00094,加转写 ≈ $0.00134,**每千张约 $1.34**;每次分类调用输入约 5000 token(图 ≈ 1500,静态提示词 ≈ 3500)。

**从数据里得出的、要写进 P2 的具体规则**

1. **日期格式**(唯一一张日期错的): 单据印 `22-04-16`(标准答案是 2016-04-22,即日-月-年),两次都读成 2022-04-16(按年-月-日读)。→ 提示词写明「马来西亚单据日期是 日/月/年,两位数年份不要当成年-月-日」;再加一条确定性检查: 单据印了 GST 字样(GST 实施期 2015-04 到 2018-05)而日期落在这个范围之外 → 标「日期存疑」。这张小票作为回归用例。
2. **长数字格式校验**: 同一个 GST 号在不同调用里被读成 `0009886880896`(13 位)、`000986880896`、`000986600696`、`000986680896` …(正确的应是 12 位)。不只是读错,还会多一位少一位。结构化那一步两次都读成 13 位的错值。→ 对 GST / SST 号按 12 位数字校验,不符合就标「需检查」;注册号按已知格式校验。
3. **总额会随机变**: 同一张图两次运行总额一次 10.00、一次 9.00(标准答案 9.00)。运行 1 的错值会被「付款 10 − 找零 1 = 9 ≠ 总额 10」的对账抓住。→ **对账和「金额必须在转写里找到」的交叉验证必须保留**,不能因为换了更强的读取器就拿掉;关键字段读不一致时才做第二次读取(省钱)。
4. **客户名读成 `CASH`**: 一张小票的对方被读成 "CASH"(付款方式被当成客户名)。→ 对方名是 CASH / CASH SALE / CASH CUSTOMER / WALK-IN 这类词时当作「没有客户」。
5. **类型清单缺 `cash_sale`**: 6 张零售小票里 5 张印着 "TAX INVOICE"(GST 时代的普遍写法),模型靠 CASH / CHANGE 判断为收据是对的。其中一张(Gardenia)印的是 TAX INVOICE + Bill To + "Received above goods in good order",模型判成销售发票,**很可能比数据集标签(一律叫收据)更对**;另一张(Kedai Papan)有 Bill To 又是现金付款,模型判收据但把握度只有 0.60 —— 本来就是模糊的。现金付款又开了抬头的发票,在 AutoCount 里是 **Cash Sale(CS)**(销售方向)或现金采购(采购方向),取决于「我们是谁」。→ 映射表加上「收据 + 销售方向 → `sales.cash_sale`」(该实体已核对过字段),收据 + 采购方向保持 PV。
6. **把握度**: 判对平均 0.87 / 判错平均 0.85–0.90,**没有区分度**,但这里的"错"其实是标签噪声;唯一真正模糊的那张得了最低的 0.60,方向是对的。样本太少,**不设固定阈值**,继续按 D10(非收据不自动放行)。
7. **性能**: 静态提示词约 3500 token,每次都重复付费。P7 评估提示词缓存(把静态说明放进 system 并缓存,图片放后面);注意缓存有最小长度,3500 可能不够,**要实测,不假设有效**。

**P0 还没验证的**: 非收据类型(发票 / 订单 / 报价单 / 送货单 / 贷项)的分类准确率 —— 没有真实样本。SROIE 的标签全是「收据」,而且上面已经看到这些标签本身有噪声,**不能再用它评测分类**。这部分按计划留到你提供样本或合成样本之后。

**P2 实际做了什么**

新增 / 改动的文件
- `shared/doctypes.ts`: 新增 **`invoice`(发票,方向未定)** 类型、`MODEL_DOC_TYPES`(模型能输出的类型)、`specificType`、`amountsRequired`;收据 + 销售方向 → `sales.cash_sale`(CS)。
- `server/lib/docPrompt.ts`: 提示词 + 模型输出 Schema(无可空类型)改为 p2 版本;日期按 日-月-年;「印着 TAX INVOICE 的现金小票是收据」。
- `server/lib/classify.ts`(新): `classifyDocument`(类型校验、证据核对、对方 / 方向、商家 = 对方、标题关键词清洗、冲突检查、日期 / 证件号检查、判定)、`applyClassification`(合进初判,只降不升)、`classifyOpts`。
- `server/lib/docchecks.ts`(新): 证据核对、CASH 类占位客户名、标题 / 关键词清洗、日期合理性(GST 时代)、税号 / 注册号位数。
- `server/lib/ourCompany.ts`(新): 可选的「我方身份」配置与匹配。
- `server/lib/claude.ts`: 分类模式(`classify`):一次调用同时分类 + 读字段(结构化输出),Schema 被 API 拒绝时自动退回仅提示词;输出带 `doc`。`server/lib/ocr.ts`: `StructuredOutput.doc`。
- `server/lib/scan.ts`: 扫描时接入分类,商家换成「对方」,`applyClassification`,`doc` 入库;`ScanOutcome` 带 `documentType / direction / title`(重复图片也带)。
- `server/lib/receipts.ts`: 批准 / 批量通过时,**不要求总额的类型**(送货单、订单、报价单、other)不再被「缺总额」挡住。
- `server/index.ts`: 新增环境变量 `CLAUDE_CLASSIFY`(默认开)、`CLAUDE_STRUCTURED`、`OUR_COMPANY_NAMES / _REG_NOS / _TAX_IDS`、`CLASSIFY_TRUSTED_TYPES`(默认 `receipt`)、`CLASSIFY_MIN_CONFIDENCE`(默认 0.8)。
- 测试: `docchecks` / `classify` / `claude-classify` / `classify-scan`(完整一条路,含「去掉保护后测试会失败」的破坏性验证)等,并更新了 P1 / 提示词测试。

**与原计划的差异(以此为准)**
1. **新增 `invoice` 类型**(原来是 8 个,现在 9 个)。销售发票和采购发票在图上长得一模一样,模型分不出(P0 里 Gardenia 那张就是例子),让它直接选等于随机猜。现在模型只判断「发票」,**由代码按我方身份落成 `sales_invoice` / `purchase_invoice`;没配置我方身份就保持 `invoice`(方向未定)**,不硬猜。`invoice` 不能写入 AutoCount(`postable: false`),要先定方向。
2. **D10 的状态方向更正**(见上): 降成 `REVIEW`,不是 `AUTO`。
3. **收据 + 销售方向 = 现金销售(CS)**(来自 P0 的发现)。
4. **没有做「关键字段读不一致时二次读取」**: 长数字目前只做位数校验并标「需检查」;二次读取放进 P7(要多花一次调用,先看校验够不够)。
5. **没有做「低置信度升级更强模型」**(B5),仍在 P7。
6. 分类的原因代码新增了 `type_unchecked`(没有整页转写,证据没法核对,只是提示)。

**P2 的已知限制(诚实地写在这里)**
- 分类逻辑是用假 Claude 测的,**没有在真实接口上端到端跑过**;真实接口只在 P0 验证了请求和 Schema。建议下一步用 P0 脚本的同类方式,对几张真实单据跑一次完整扫描。
- **非收据类型的分类准确率仍然没有任何真实样本验证过**,所以它们全部转人工是故意的。
- 把握度阈值 0.8、候选间距 0.2 是占位值。
- 标题 / 关键词只做了形状和内容清洗,语言是否合适(单据语言 vs 英文)没验证。

**P1 实际做了什么**(新增 / 改动的文件)
- 新增 `shared/doctypes.ts`(8 个类型、映射表、方向、`verified` 标记)、`shared/doc.ts`(存储的文档信息)、`shared/public2.ts`(`toPublicV2`)、`shared/schema/document-v2.schema.json`。
- 新增 `server/lib/doc.ts`(`cleanDoc`: 入库唯一关口,只认约定的键、枚举不合法就丢、字符串截断并过银行卡号掩码)。
- `server/db.ts` 迁移 **v10**;`server/lib/importer.ts` / `receipts.ts` / `app.ts` / `shared/types.ts` 接入新列、`doc`、类型 / 方向筛选。
- 测试: `docv2.test.ts`、`migration-v10.test.ts`、`fixtures/docv2.ts`(8 个类型各一份)、`helpers/jsonschema.ts`(项目没有 ajv,自带最小校验器)。

**与原计划的差异**(以此为准)
1. `doc` JSON 放在 **`receipt_blobs.doc`**,不是 `receipts.doc`: 列表查询不用读大字段;列表要用的(类型、方向、置信度、单据号、标题、`doc_edited`)放在 `receipts`。
2. 实际校验中发现对账检查项的状态有 **`info`**(不只是 ok / warn / fail),已在 Schema 和 `openapi.yaml` 中修正。**`receipt-portal-haiku` 里已交付的 `openapi.yaml` 也有同样的错,已一并改正。**
3. 不认识的类型 / 方向筛选值返回**空列表**,不是悄悄忽略筛选返回全部数据。
4. `v1` 完全没有改动(`shared/public.ts`、`/v1/*` 路由原样)。
关系: `PLAN-document-classification.md` 是**设计**(是什么、为什么);本文是**执行**(做哪些事、改哪些文件、什么顺序、怎样算做完)。两份冲突时以本文为准,本文已吸收了你最新的决定。

---

## 0. 先说结论

1. **能做,而且不需要推倒重来。** 现有的读取、校验、对账、分流、API、审核页都能复用;新增的是「分类层」「v2 合同」「AutoCount 模块」三块。
2. **最大的结构性风险不在模型,在「系统是围绕收据设计的」**: 数据库、类型、审核页(`ReviewPage.tsx` 1426 行)、CSV 导出、分析页,全部默认「一张票 = 商家 + 日期 + 金额」。所以本计划的核心设计是: **旧的列保留作为"通用扁平视图",新信息放进一个 JSON 字段**,这样旧界面不会被打坏。
3. **你的新决定改变了顺序**: AutoCount 匹配从"第二阶段"提前到和 JSON 同时做。我把它拆成「只读匹配(早做、风险低)」和「写入(晚做、默认关闭、只对演示账套)」,不然整体会被写入的风险拖住。
4. **评测样本没有**,所以没法承诺准确率。计划里用三样东西顶替: 合成的测试单据、「每次人工复核都变成一条标注」的回流、以及上线前必须有一个小样本抽检。**样本一到,第 2 阶段要回头标定阈值。**
5. **有一件事必须你来做**: 第 0 阶段要用你的 Anthropic 密钥在真实接口上验证,我不接触密钥。

---

## 1. 现状分析(用来定改动范围)

### 1.1 我们这边(`receipt-portal-autocount`)

| 区域 | 文件(行数) | 现状 | 对本任务的影响 |
|---|---|---|---|
| 识别 | `server/lib/claude.ts`(190) | 一次读字段 + 商品行(JSON 提示词),另一次独立转写;字段名固定为 `CORE_FIELDS` / `EXTRA_FIELDS` | **要扩**: 提示词、输出结构、分类字段 |
| 规整 | `server/lib/structured.ts`(551) | `fromStructured` 把模型输出变成 `ReceiptData`、做金额修复、对账、分流 | **要扩**: 新字段映射、按类型对账 |
| 分流 | `server/lib/extract.ts`(331) | `triage`: AUTO_VERIFIED / AUTO / REVIEW …,原因代码 | **要扩**: 分类相关原因 |
| 对账 | `shared/reconcile.ts`(380) | 小计 / 税 / 总额 / 付款 / 找零等检查 | **要按类型开关**(送货单不对账金额) |
| 扫描 | `server/lib/scan.ts`(114) | 串起识别 → 入库,返回 `ScanOutcome` | **要扩** |
| 入库 | `server/lib/importer.ts`(130)、`server/db.ts`(172) | `ingest` 写 `receipts` + blobs;迁移现在到 **v9** | **新增迁移 v10** |
| 公开合同 | `shared/public.ts`(74)、`server/lib/v1.ts`(38) | `/v1` 的 `PublicReceipt` | **v1 冻结不动,新增 v2** |
| 路由 | `server/app.ts`(276) | `/api/*`(界面)、`/v1/*`(对外) | **新增 `/v2/*`** |
| 类型 | `shared/types.ts`(226) | `ReceiptData`、`ReceiptRow`、`ReceiptDetail`、`ScanOutcome` | **要扩** |
| 界面 | `web/src/pages/ReviewPage.tsx`(1426)、`DataPage`(309)、`AnalyticsPage`(251)、`ScanPanel`(82)、i18n zh/en 各约 240 行 | 全是收据视角 | **要扩,但只增不改旧逻辑** |
| 测试 | `server/tests/`(28 个测试文件,467 个测试) | 全绿 | **必须保持全绿**(回归线) |
| 评测 | `eval/` | 脚本指向 MiniCPM,标准答案全是零售小票 | 分类评测要**新建** |

### 1.2 AutoCount 这边(从 `bi-autocount` 和本机 MCP 读到)

- **同一个连接器**: `acmcp.exe` 已装在本机 `C:\Users\user\AppData\Local\Programs\AutoCountMcp\acmcp.exe`(版本 0.21.0,最新 0.30.0)。`bi-autocount` 用 `StdioBookConnector`(226 行)以子进程方式启动它,走 MCP(JSON-RPC over stdio),**一个进程服务所有账套**,启动超时 30 秒、单次调用 200 秒、空闲 10 分钟自动停。
- **`bi-autocount` 目前只放行只读工具**: `run_report`、`report_data`、`lookup_codes`、`query_book`、`book_profile`。写入(`preview_write` / `apply_write`)**还没有任何地方在用**,它们的计划里是「阶段 5: describe → preview → 员工确认 → apply → 按单号对账」,而且被「无头 acmcp 的连接器合同」卡着。→ **写入这条路我们要自己走通,不能指望复用现成的。**
- **写入规则(来自 `describe_entity`)**: 先问账套(`bookConfirmed`)→ `preview_write` 得到将要保存的样子 + 警告 + 10 分钟有效的 `confirmToken` → 把预览里的问题**原话**问给人,人说 yes 才带 `actionConfirmed: "yes"` 调 `apply_write`。账套开了审批就保存成草稿。
- **主档必须已存在**: 客户 / 供应商代码、商品代码、税码、币种、付款方式、会计科目都要存在且启用 —— 所以必须先「匹配」,匹配不上就不能写。
- **账套**: `demoretailbook`(演示)、`PFP_BIDashboard` 和 `precious-food-products-sdn-bhd`(后两个指向同一个数据库 `AED_PFPBIDashboard`,从 `bi-autocount` 的文档看**很可能是真实客户**,按真实客户对待)。**开发联调只用 `demoretailbook`。** 演示账套 e-Invoice 未启用,保存销售类单据不会提交到 LHDN。
- **`bi-autocount` 的生产形态**: 线上后端是 Cloudflare Worker,经客户电脑上的 relay(cloudflared 隧道)访问 AutoCount;Worker **访问不到局域网地址**。这意味着: 我们的 API 要被它线上调用,必须有公网 https 地址。本计划不解决部署,但会在第 7 阶段把它列为明确的前置条件。

---

## 2. 关键设计决定(含理由)

| # | 决定 | 理由 |
|---|---|---|
| D1 | **扁平列 + JSON 文档字段**: `receipts` 旧列保留(`merchant` / `date` / `currency` / 各金额 / `items`),新增一个 `doc` JSON 字段存完整 v2 载荷,再加少数可索引的列(`document_type`、`direction`、`doc_no`、`title`) | 旧界面、导出、分析、评测都读旧列,不改就不会坏;v2 读 `doc` |
| D2 | **旧列的 `merchant` = "对方"**: 采购类取开单方,销售类取客户,收据取商家 | 商家别名记忆、分析页的"按商家"统计继续有意义 |
| D3 | **类型清单和映射做成一份数据**(`shared/doctypes.ts`): 枚举、中英文名、AutoCount 实体、方向、字段要求、对账开关 | 提示词、校验、界面下拉、AutoCount 映射、`/v2/types` 都从这一份生成,加类型只改一处 |
| D4 | **方向不强绑**: `OUR_COMPANY` 可选。没配置时 `direction = unknown`,**但 `issuer` / `counterparty` 照常精确输出**,由调用方(bi-autocount 自己知道自己是谁)决定 | 满足"逻辑能跑、输出数据给对方"的要求,不被配置卡住 |
| D5 | **分类证据必须能在转写里找到**,否则降级转人工 | 沿用现有「读出的金额必须在原文里找到」的做法,防止模型编造;也挡一部分提示注入 |
| D6 | **匹配和写入拆开**: 匹配只读(`lookup_codes` 等),写入默认关闭(`AUTOCOUNT_WRITE=off`),开启后也只走预览 + 人工批准,只对演示账套 | 风险分级,早交付低风险部分 |
| D7 | **AutoCount 访问放在我们这个服务里**(`server/lib/autocount/`),通过接口 `AutoCountClient` 抽象,默认实现是 stdio 连接 `acmcp` | 现在能跑;将来 bi-autocount 想自己匹配,可以换实现或忽略我们给的候选,不影响 JSON |
| D8 | **v1 冻结,新开 v2** | 不破坏已经联调的调用方 |
| D9 | **首版类型 8 个**: 收据、销售发票、采购发票、销售订单、报价单、送货单、贷项通知单、其他 | 你已确认;其余先归 `other` |
| D10 | **所有"未验证"都显式标出**: 分类结果带 `type_verdict`,没有评测样本期间默认不允许分类结果单独触发自动放行 | 诚实地反映我们不知道准确率;样本到位后再放宽 |

**关于 D10 的具体含义(2026-11-17 更正)**: 在拿到标定数据之前,一张单据即使金额全部对得上,只要是"非收据类型",就**不能自动放行**: 状态降成 **`REVIEW`(需检查)**,并带上 `type_unverified` 原因。收据类型保持现有行为。这样不会出现"类型分错了却被自动放行"。
> 这一段原来写的是"最高到 `AUTO`",**写反了**: 在这个系统里 `AUTO` 比 `AUTO_VERIFIED` 更可信(最高档),"最高到 AUTO"等于放宽而不是收紧。P1 的夹具用的本来就是 `REVIEW`,代码也是降到 `REVIEW`。

---

## 3. 工作清单(完整盘点)

按区域列出所有要做的事。编号 `T区.序号`,第 4 节按阶段排序。

### A. 合同与存储
- **A1** `shared/doctypes.ts`: 类型枚举、映射表、字段要求、对账开关(D3)。
- **A2** `shared/public2.ts`: v2 载荷类型(`PublicDocumentV2`)+ 构造函数 `toPublicV2`。
- **A3** `shared/schema/document-v2.schema.json`: 机器可读的 JSON Schema,和 `openapi.yaml` 同步。
- **A4** `server/db.ts` 迁移 v10: `receipts` 新增 `document_type`、`direction`、`type_confidence`、`doc_no`、`title`、`doc`(JSON)、`doc_edited`(人工是否改过分类);索引 `(document_type, direction)`、`(doc_no)`。**不回填旧数据。**
- **A5** `shared/types.ts` / `server/lib/receipts.ts`: `ReceiptRow` / `ReceiptDetail` 带新字段;列表支持按类型 / 方向 / 关键词筛选。
- **A6** 迁移测试: 在一份**拷贝的 v9 库**上升级到 v10,旧数据完好。

### B. 识别(模型这一层)
- **B1** 新提示词: 一次调用同时要分类 + 字段 + 标题 + 关键词 + 对方信息 + 商品行。格式、证据要求、不确定就标 `other`。
- **B2** 输出结构: 先试 `output_config.format` 的 JSON Schema(第 0 阶段验证);不可用则回退到现有的"提示词 + 解析器"。
- **B3** `claude.ts` 返回扩展的 `StructuredOutput`(新增 `classification` 等字段)。
- **B4** 选项: `CLAUDE_CLASSIFY=on/off`(关掉就回到收据模式,方便回退和对比)。
- **B5** 低置信度二次读取(可选,第 7 阶段): 仅对 `confidence` 低的用更强模型重读。

### C. 分类后处理(新模块 `server/lib/classify.ts`)
- **C1** 校验 `document_type` 在启用清单里,否则 `other`。
- **C2** 校验 `evidence` 存在于转写(D5);全不在 → 降级。
- **C3** 类型与结构矛盾检查(送货单却有找零、订单却有付款 …)。
- **C4** 置信度阈值 + 第一第二候选间距 → `type_verdict`。
- **C5** 提示注入防护: 证据必须是引用;标题 / 关键词清洗(长度、去重、剔除金额 / 长数字 / 邮箱 / 证件号)。

### D. 对方与方向
- **D1** `server/lib/parties.ts`: 归一化(去 SDN BHD / BHD / 标点 / 大小写)、注册号和税号优先匹配。
- **D2** `OUR_COMPANY` 可选配置(名称 + 别名 + 注册号 + 税号),环境变量或 `data/our-company.json`。
- **D3** 方向判定(D4 决定): 命中开单方 → sales;命中对方 → purchase;都不命中 / 都命中 / 没配置 → unknown;收据默认 purchase。
- **D4** 把 `merchant` 旧列按 D2 决定填好;复用现有商家别名记忆。

### E. 按类型的字段要求、对账与分流
- **E1** `fromStructured` 接受新字段,映射到 `ReceiptData` + `doc`。
- **E2** 按类型开关对账(`shared/reconcile.ts` 增加类型参数,不改默认行为)。
- **E3** `triage` 增加: 分类相关原因代码(`type_low_confidence`、`direction_unknown`、`type_evidence_missing`、`type_conflict`、`type_unverified`)。
- **E4** D10: 非收据类型在未标定前不能自动放行(降成 `REVIEW`)。

### F. API v2(`server/app.ts` + 新 `server/lib/v2.ts`)
- **F1** `POST /v2/scan`(同 v1 + 可选 `hint_type`、`batch`)。
- **F2** `GET /v2/receipts/:id`、`GET /v2/receipts?type=&direction=&q=&from=&to=&page=`。
- **F3** `GET /v2/types`、`GET /v2/health`(启用类型、我方身份是否配置、AutoCount 连接状态)。
- **F4** 新错误码 `422 TYPE_NOT_ENABLED`;`openapi.yaml`、`API.md` 更新。
- **F5** 契约测试(请求 / 响应 / 错误码)。

### G. AutoCount 模块(`server/lib/autocount/`)
- **G1** `connector.ts`: 移植 `StdioBookConnector`(spawn `acmcp.exe`,MCP stdio,超时与空闲回收),我们自己的允许清单(只读 + 受控的写)。
- **G2** `client.ts`: `AutoCountClient` 接口 + 真实实现 + **假实现**(测试用)。
- **G3** `match.ts`: 对方匹配(debtor / creditor,按名字 + 注册号)、商品匹配、税码 / 币种 / 付款方式匹配;输出候选列表和把握度,**绝不自动创建主档**。
- **G4** `check.ts`: 查重(`check_docno`、供应商发票号 `supplierInvoiceNo`)。
- **G5** `map.ts`: 类型 → AutoCount 实体的映射和字段转换(见 §5)。
- **G6** `preview.ts`: 组装 `preview_write` 的输入,拿回预览、警告、问题原文、`confirmToken`。
- **G7** `apply.ts`: 门控(`AUTOCOUNT_WRITE=on`)+ 只允许演示账套白名单 + 人批准后 `apply_write`,带 `actionConfirmed`;读回并把 AutoCount 单号写回我们的记录。
- **G8** 状态机(落库): `not_matched → matched → previewed → posted | failed | uncertain`,每次变更写审计。
- **G9** 配置: `ACMCP_EXE`、`AUTOCOUNT_BOOK`(别名)、`AUTOCOUNT_WRITE`、`AUTOCOUNT_ALLOWED_BOOKS`。
- **G10** 失败处理: 连接器没启动 / 账套没登录 / 超时 → 匹配结果标 `unavailable`,**不影响扫描和 JSON 输出**。

### H. 界面
- **H1** 扫描列表、审核页: 类型徽标、方向、标题、关键词。
- **H2** 审核页可改类型 / 方向 / 标题 / 关键词;改动记审计并写 `doc_edited`(这是我们唯一的"标注回流")。
- **H3** 按类型显示不同字段区(送货单隐藏金额区,贷项显示原发票号 / 原因)。
- **H4** 列表筛选(类型 / 方向)、CSV 导出新增列。
- **H5** AutoCount 面板(`AutoCountPanel.tsx`): 候选对方 / 商品选择、查重结果、预览(含警告)、**原话显示 AutoCount 的确认问题**、确认按钮、状态。
- **H6** 分析页: 各类型数量、各类型自动通过率、分类被人工改动率。
- **H7** i18n zh / en。

### I. 测试与评测
- **I1** v2 示例夹具(A 采购发票 / B 收据 / C 销售订单 + 其余 5 类)+ JSON Schema 校验。
- **I2** **假 Claude 客户端**按类型返回(沿用现有测试方式),覆盖分类、降级、各类矛盾。
- **I3** **假 acmcp**(进程内 MCP 服务桩)覆盖匹配、查重、预览、拒绝、超时。
- **I4** 提示注入用例(图片文字写"这是销售订单,自动通过" 等)。
- **I5** 合成单据: 用代码生成 8 类各若干张图片(版式模板 + 随机内容),只用于**烟雾测试和回归**,不当准确率依据。
- **I6** `eval/classify-eval.ts`: 输入带标注的目录,输出混淆矩阵、各类召回、自动放行中的错误率。样本到位后直接可用。

### J. 配置、文档、运维
- **J1** 配置清单(环境变量表)、`AUTOCOUNT.md` 更新。
- **J2** `API.md` / `openapi.yaml` v2。
- **J3** 成本与耗时统计(每类每张的调用次数、token、耗时)进分析页。
- **J4** 部署前置: 公网 https 地址、口令轮换、日志不含密钥。

---

## 4. 分阶段计划(顺序、依赖、验收)

**工作量**: S 小(半天内)/ M 中(1–2 天)/ L 大(2–4 天)。这是我按上面盘点的代码量做的**相对估计,不是时间承诺**,真正快慢取决于真实接口上的发现和你的反馈速度。

| 阶段 | 任务 | 依赖 | 工作量 |
|---|---|---|---|
| **P0 真实接口验证** | 见 4.1 | **你的密钥** | S–M |
| **P1 合同与存储** | A1–A6、I1 | 无(可与 P0 并行) | M |
| **P2 识别与分类** | B1–B4、C1–C5、D1–D4、E1–E4、I2、I4 | P0(提示词和输出格式)、P1 | L |
| **P3 API v2** | F1–F5 | P1、P2 | M |
| **P4 AutoCount 只读匹配** | G1–G4、G9–G10、I3 | P1(可与 P2 并行) | L |
| **P5 界面** | H1–H4、H6–H7 | P1、P3 | L |
| **P6 AutoCount 写入** | G5–G8、H5 | P4、P5 | L |
| **P7 加固与交付** | B5、I5、I6、J1–J4 | 全部 | M |

**总量粗估**: 约 12–18 个工作日。**最短可用路径** = P0 → P1 → P2 → P3(对方系统能拿到 v2 JSON)。P4 与 P2 并行,P5、P6 排在后面。

### 4.1 P0 —— 真实接口验证(要你的密钥)

目的: 把"我之前从未在真实 API 上测过"这件事清掉。**我写好一个脚本,你在自己的窗口设好密钥后运行,把输出贴给我**(输出里不含密钥)。

| # | 验证项 | 通过标准 | 不通过时的退路 |
|---|---|---|---|
| 0.1 | 当前请求参数(`thinking: disabled` + `effort: low`)被接受 | 返回 200 | 去掉 / 调整参数 |
| 0.2 | `output_config.format` JSON Schema 在 Haiku 5.5 上可用,枚举被遵守 | 100% 返回合法 JSON、枚举值合法 | 回退到提示词 + 解析器(B2) |
| 0.3 | 图片尺寸 / 清晰度: 长条形收据在 1568 像素下的读取质量 | 肉眼核对 3–5 张长票的商品行 | 把长票切成上下两段分别读 |
| 0.4 | 耗时和 token: 字段调用 + 转写调用 | 记录每张中位数 | 影响并发和成本预期 |
| 0.5 | 用 5–10 张现有收据 + 2–3 张你手头的发票 / 订单做**分类烟雾测试** | 能给出合理类型 + 证据 | 调提示词 |
| 0.6 | 费用: 每张实际花费 | 记录 | 评估是否要关交叉验证 |

### 4.2 各阶段验收标准

**P1**: 全部 467 个旧测试仍绿;v10 迁移在 v9 库拷贝上通过且旧数据完好;3 个示例 + 另外 5 类示例通过 JSON Schema 校验。

**P2**: 假 Claude 测试覆盖 8 类 + 全部降级路径;非收据类型**不会**得到 `AUTO_VERIFIED`(D10);提示注入用例全部不被放行;收据类型在原有 SROIE 回归集上**分数不低于现在**(自动通过率和错放数不恶化)。

**P3**: `/v2` 契约测试全过;`/v1` 行为**逐字节不变**(用现有 v1 测试保证);`openapi.yaml` 与实现一致(用示例请求核对)。

**P4**: 假 acmcp 测试覆盖命中 / 多个候选 / 零候选 / 超时 / 未登录;**连接器不可用时 `/v2/scan` 仍然正常返回**;在 `demoretailbook` 上真实跑通: 给一个已知供应商名能返回候选。

**P5**: 界面能改分类并写审计;旧页面所有功能不退化(手工点一遍 + 现有前端类型检查通过);中英文齐全。

**P6**: `AUTOCOUNT_WRITE` 默认关,关着时任何写入接口都 `409`;只对白名单账套;预览问题**原文**展示;人没点确认绝不调用 `apply_write`;对每个启用类型在**演示账套**上完成一次端到端(预览 → 确认 → 保存 → 读回单号),保存后用 `check_docno` 核对。

**P7**: 成本和耗时有统计;文档齐全;安全清单逐条核过(见 §6)。

---

## 5. 类型到 AutoCount 的映射与写入细则

| 本服务类型 | 方向 | AutoCount 实体 | 对方主档 | 行需要 | 备注 |
|---|---|---|---|---|---|
| sales_invoice | sales | `sales.invoice` | debtor | `itemCode` | 开了 e-Invoice 的账套保存会自动提交 LHDN → 写入前必须告知 |
| quotation | sales | `sales.quotation` | debtor | `itemCode` | 字段按销售订单类推,**P6 前用 `describe_entity` 核对** |
| sales_order | sales | `sales.order` | debtor | `itemCode` | 已核对: 只是承诺,不动应收 / 库存 / 总账 |
| delivery_order | sales | `sales.delivery_order` | debtor | `itemCode` | **P6 前用 `describe_entity` 核对**(是否动库存、字段) |
| credit_note | sales / purchase | 销售 `sales.credit_note`;采购方向用 `ap.credit_note` | debtor / creditor | `itemCode` | 销售贷项已核对: 带 `reason`、`cnType`、`ourInvoiceNo`;`ap.credit_note` 的字段 P6 前核对 |
| purchase_invoice | purchase | `purchase.invoice` | creditor | `itemCode` | `supplierInvoiceNo` 用来查重 |
| receipt | purchase | `gl.cash_book`(付款凭证 PV) | 无(`payTo` 是名字) | `accNo` + 金额 | 小票没有商品代码,所以走现金账;需要**默认费用科目**配置 |
| other | — | 不写入 | — | — | 仅输出 JSON |

**匹配规则**
- 对方: 注册号 / 税号精确命中优先 → 名字归一化后完全一致 → 名字相似度高于阈值(只作为候选,不自动选)。多个候选或零候选 = `needs_choice`,由人选。
- 商品: 描述相似度匹配 `itemCode`;匹配不上的行,按配置用"通用商品"或标 `unmatched` 让人决定。**收据走 PV 时不需要商品匹配。**
- 税码、币种、付款方式: 查 `lookup_codes`,查不到给警告,不擅自改。
- 查重: `check_docno`(我们不指定单号时不需要)+ 供应商发票号 + 同一图片哈希(我们已有)。

**写入细则(来自 MCP 的约束,必须遵守)**
1. 第一次对某账套预览,会先被要求回答「账套问题」(公司、数据库、备份提醒)→ 我们的界面**原话展示**,人确认后再带 `bookConfirmed: "yes"`。
2. 预览返回的问题**原话展示**给审核员;只有点了确认才带 `actionConfirmed: "yes"`。
3. `confirmToken` 10 分钟有效、一次性;过期或账套在预览后被改动,`apply_write` 会拒绝,需重新预览。
4. 不传 AutoCount 能自己填的东西(价格、税码、科目),**只传用户给的**;不指定单号。
5. 账套开了审批 → 保存成草稿,不过账;界面要明确显示"草稿,需在 AutoCount 里批准"。
6. **永不调用** `submit_einvoice`、`apply_delete`、`email_document`、`sign_in`、`sign_out`、`setup_book`、`connect_book`。允许清单里没有它们。
7. 不用原始 SQL 写入(`bi-autocount` 的 `CLAUDE.md` 明确禁止)。

---

## 6. 安全与隐私清单

| 项 | 措施 |
|---|---|
| 真实客户账套 | 允许清单 `AUTOCOUNT_ALLOWED_BOOKS` 默认只含 `demoretailbook`;配置里出现其他账套时,启动日志警告;写入对非白名单账套一律拒绝 |
| 误写入 | 写入默认关闭;预览 + 人工批准;所有写入尝试(含被拒绝的)记审计 |
| e-Invoice | 不触发提交;销售类写入前明示"此账套会 / 不会自动提交 LHDN" |
| 提示注入 | 图片文字一律当数据;分类证据必须在转写里;分类结果**不直接决定放行**(D10);标题和关键词清洗;`untrusted_text_fields` 沿用并扩展 |
| 隐私 | 图片发送到 Anthropic(已有提示);关键词不放金额 / 证件号 / 银行账号;`card_last4` 仅在图上印着时保留末四位 |
| 凭据 | 密钥和口令只放环境变量;日志、错误响应不含密钥片段(已有);`acmcp` 的 AutoCount 登录由 Windows 用户保存,不经过我们 |
| 多租户 | 本服务目前**不是多租户**(一个口令一个数据库)。`bi-autocount` 是多租户,所以它对接时每个租户应该用各自的口令 / 部署,**不要共用一个数据库**。这点要在 P7 文档里写明 |
| 访问控制 | `/v2/*` 沿用 Bearer 口令;`/api/autocount/*`(界面用)只在门户内可用 |

---

## 7. 风险登记

| # | 风险 | 可能性 | 影响 | 应对 |
|---|---|---|---|---|
| R1 | 系统收据中心,改动波及面大(`ReviewPage` 1426 行) | 高 | 旧功能被打坏 | D1(旧列不动)+ 只增不改 + 旧测试全绿作为每个提交的门槛 |
| R2 | 没有评测样本,分类准确率未知 | 确定 | 无法保证质量 | D10(非收据不自动放行)+ 标注回流 + 上线前小样本抽检 + 样本到位后回头标定 |
| R3 | 结构化输出在 Haiku 5.5 上不如预期 | 中 | P2 延期 | P0 先验证,有回退方案(B2) |
| R4 | `acmcp` 版本老(0.21 vs 0.30)、无头模式 / 登录方式限制 | 中 | P4 / P6 受阻 | P4 先在演示账套上做最小连通验证;必要时由你升级连接器 |
| R5 | `acmcp` 写入需要客户端的"批准提示",无头客户端可能被拒 | 中 | P6 受阻 | 创建类操作按 MCP 说明由 `actionConfirmed` 控制,删除 / 取消 / 邮件不做;P6 开始时先做一次最小写入试验(演示账套) |
| R6 | 线上 Worker 访问不到局域网地址 | 确定 | 对接上线受阻 | P7 把"公网 https 地址"列为上线前置条件;本阶段不解决 |
| R7 | 方向判错 | 中 | 采购记成销售 | D4 不绑死 + `unknown` 优先 + 把 issuer / counterparty 精确给到调用方 |
| R8 | 调用次数 / 费用上升 | 中 | 成本 | 每张仍是 2 次调用;P7 做统计;低置信度升级仅限少数 |
| R9 | 误操作真实账套 | 低 | **严重** | 白名单 + 默认关闭 + 预览批准 + 审计,多层防护 |
| R10 | 模型输出的类型随版本漂移 | 中 | 回归 | 固定夹具 + 分类烟雾集 + 提示词版本号写入 `doc` |

---

## 8. 测试策略

1. **回归线**: 现有 467 个测试,每个阶段结束必须全绿,类型检查(服务端 + 前端)无错。
2. **单元**: 分类后处理、方向判定、归一化、类型映射、对账开关、标题 / 关键词清洗。
3. **契约**: `/v2` 请求 / 响应 / 错误码,用 JSON Schema 校验响应;`/v1` 逐字节不变。
4. **假依赖**: 假 Claude(按类型返回)、假 acmcp(MCP 桩)—— **所有自动测试不联网、不花钱、不碰账套**。
5. **安全**: 提示注入、超长标题、恶意关键词、越权账套、写入开关。
6. **端到端(人工,P0 / P4 / P6)**: 用真实密钥和演示账套各做一次,留记录。
7. **评测(样本到位后)**: `classify-eval.ts` 出混淆矩阵;各类召回、自动放行里的错误率、方向准确率。

---

## 9. 需要你提供 / 决定的(精简版)

| # | 事项 | 何时需要 | 没有它会怎样 |
|---|---|---|---|
| 1 | 在你自己的窗口设置 Anthropic 密钥并运行 P0 脚本、贴回输出 | P0 | P2 的提示词和输出格式没法定 |
| 2 | 确认联调账套只用 `demoretailbook` | P4 | 我默认只用它 |
| 3 | 默认费用科目(收据走 PV 用) | P6 | 收据写入无法进行,只能停在预览 |
| 4 | 样本单据(哪怕 20–30 张混合类型) | 越早越好 | 分类阈值没法标定 |
| 5 | `bi-autocount` 线上调用我们的方式(公网地址 / 隧道) | P7 | 本地联调不受影响,上线受阻 |
| 6 | 是否升级 `acmcp` 到 0.30 | P4 开始前 | 默认先用 0.21 试,不行再说 |

---

## 10. 下一步

**立即可做、不需要你的密钥**: P1(合同与存储)。建议顺序: A1 → A2/A3 → A4/A6 → I1 → A5。
**需要你配合的第一件事**: 抽空运行 P0 脚本(我先写好并说明怎么跑)。
**不做**(明确排除): 自动创建 AutoCount 主档、自动保存 / 过账 / 提交 e-Invoice、对真实客户账套的任何写入、PDF / 多页(放 P7 之后)。


## P3 实际做了什么 / 与原计划的差异

- 路由 `/v2/*` 复用 `/v1` 的口令校验(Bearer),不需要 `x-portal`;对外字段统一下划线命名。
- `hint_type`: 调用方已知类型时可以指定,跳过模型置信度 / 证据检查,其余检查(可信类型、日期、证件号、冲突)照常;未知类型 422 `TYPE_NOT_ENABLED`。
- 列表: `type` 不认识 → 422;`direction/state/from/to` 格式不对 → 400;`page_size` 1..100(默认 20),按编号倒序。
- **防漂移测试发现并修掉的真问题**:
  1. `document-v2.schema.json` 的 `document_type` 枚举漏了 `invoice`(方向未定的发票),模型返回 `invoice` 时会被判为结构不合法。已补。
  2. 旧测试「枚举不合法」恰好用 `invoice` 当反例,因此掩盖了上一条;已改用 `bank_slip`。
  3. 原 `openapi.yaml`(v1)里有一处未加引号的 `description`(含「error: it」),严格的 YAML 解析器会拒绝整个文件;已加引号。**`receipt-portal-haiku` 副本里的同一份文件也有这个问题,尚未改。**
- `DocumentV2` 的 OpenAPI 定义由 JSON Schema 转换生成(nullable 转成 OpenAPI 3.0 写法),不是手抄。
- 仍未做: `item_code_printed` 恒为 null;`outstanding` 恒为 null;PDF 不支持;非小票类型默认都进入 REVIEW(没有真实样本验证准确率)。
