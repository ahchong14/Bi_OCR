# receipt-portal-autocount —— 面向 AutoCount 的单据分类版

这是 `receipt-portal-haiku` 的副本,专门用来做「单据自动分类 + 标准 JSON + AutoCount 对接」。
**开发都在这个文件夹里做**,另外两份不动:

| 文件夹 | 用途 | 状态 |
|---|---|---|
| `receipt-portal` | 原项目(MiniCPM + Qwen 那套) | 不动 |
| `receipt-portal-haiku` | Claude Haiku 5.5 识别器 + `/v1/scan` API,已推送到 GitHub | 保持稳定,给对方系统联调用 |
| `receipt-portal-autocount`(这里) | 在 Haiku 版基础上做分类 / `/v2` / AutoCount | **开发中** |

## 这份副本里有什么 / 没有什么
- 有: 全部代码、测试、`node_modules`、`API.md`、`openapi.yaml`、`PLAN-document-classification.md`(完整方案)。
- **没有 `.git`**: 故意的。haiku 版的 `.git` 指向 GitHub 的 `invoice_ocr`,带过来的话一不小心就会推送到同一个仓库。需要版本管理时,在这里 `git init` 并**新建另一个仓库**,不要沿用 `invoice_ocr`。
- 没有数据、数据库、备份、收据图片、`.env`、`eval/runs`、`web-dist`(前端需要重新 `bun run build`)。

## 启动(和 haiku 版一样,换个端口避免冲突)
```powershell
cd D:\ai-video-generation-model\receipt-portal-autocount
$env:ANTHROPIC_API_KEY = "<你的密钥>"
bun run build
bun run start --port 8082
```
haiku 版占 8081,这份用 8082。数据目录是这份自己的 `data\`,不会碰另外两份。

## 方案和已定的决定
完整方案见 `PLAN-document-classification.md`。你已经定下的:

1. **我方公司身份不绑死**: 做成可选配置,没配置时 `direction` 为 `unknown`,其他数据照常输出,不阻塞。
2. **首版 8 个类型**: 收据、销售发票、采购发票、销售订单、报价单、送货单、贷项通知单、其他。
3. **JSON 和 AutoCount 匹配同时做**(方案里原本放在第二阶段,现在提前)。AutoCount 匹配复用 bi-autocount 里已有的连接器,不重复连一次;写入仍是「预览 + 人工批准」,只对演示账套。
4. **暂时没有评测样本**: 不设准确率及格线,分类结果先标记为「未验证」,靠人工复核在使用中积累标注。

## 文档
| 文件 | 内容 |
|---|---|
| `PLAN-document-classification.md` | 设计: 分类体系、v2 JSON 合同、示例、评测指标 |
| `IMPLEMENTATION-PLAN.md` | **执行计划**: 工作清单、改哪些文件、分阶段顺序与验收、风险、需要你提供的东西。两份冲突以它为准 |

## 开发状态
**还没开始写分类代码**,这份副本目前和 haiku 版的功能完全一致。
