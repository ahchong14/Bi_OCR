# 交接说明(给 Claude Code)

项目: receipt-portal(Bun + Elysia + React + sharp + SQLite),用开源模型(MiniCPM-OCR,可选 GLM-OCR 第二读取、Jev 验证器)识别马来西亚/文莱收据,
本地门户做对账和人工审核。用户 Ahchong 是软件工程学生/实习生(Kuching),用中文交流,回复请用中文。

## 用户的工作习惯(重要)
- 回复用中文。解释代码时要具体追踪: 名字在哪定义、从哪调用、查了什么。
- 改代码要给「每个文件的原代码片段 → 替换成什么」,不要整文件重写。
- 代码注释写给下一个开发者看: 说明做什么、为什么;不要写需求编号。
- Windows 上这个项目的文件多数是 CRLF(ReviewPage.tsx、styles.css、zh.ts、en.ts、types.ts 等)。编辑时保持原有换行。

## 常用命令
- `bun test` (最近一次: 251 通过 / 0 失败)
- `npx tsc -p tsconfig.json --noEmit` 和 `npx tsc -p tsconfig.web.json --noEmit` (都应无输出)
- `bun run build` 然后重启 portal, 浏览器 Ctrl+F5
- `bun run reset` 清空数据目录(图片 + portal.db); 先停掉 portal
- 不要用 `pkill -f` / `pgrep -f` 去停服务(会连 shell 一起杀掉)

## 这个会话做完的事
1. 商品明细: 每行新增 uom、discount、taxRate(`Item.taxRate`, 百分比, 0 = 零税率/免税)。可选键,没有值就不写(旧数据不会被误判成「被改过」)。
   - 数据通路: shared/types.ts → server/lib/clean.ts, structured.ts → shared/items.ts(`rateOf`, 坏 JSON 抢救, 明细表格行) → shared/public.ts, server/lib/csv.ts, i18n.ts → web/src/lib/checks.ts → ReviewPage.tsx。
   - 税率没有单独建数据库列,存在收据的明细 JSON 里(`receipts.items`)。
   - 模型默认不读每行税率;设环境变量 `MINICPM_ITEM_DETAILS=on` 才会多问 uom/discount/tax(对原有 4 项准确率的影响还没在真实收据上比较过)。
2. 对账引擎 shared/reconcile.ts:
   - 含税价商品: 新增 `items_tax_incl` 参照(总额 − 服务费/其他费/小费/舍入)。
   - 新增「按税率分组算税」(3b 段): 所有行都有税率且总额对得上时, 独立算出税额和不含税小计, 给出 `tax_by_rate` 检查和 `computed_by_rate` 一键采用建议。不会自动覆盖已有值。
   - 测试: server/tests/taxrate.test.ts, reconcile.test.ts, itemdetail.test.ts。
3. 审核页(web/src/pages/ReviewPage.tsx):
   - 右侧表单现在分三页: 商家详情 / 金额 / 商品明细(`rtab` = 'details' | 'amounts' | 'items')。和商品明细相关的对账提示(`ITEM_CHECKS`)显示在第三页。点中间的模型明细表会自动切到第三页。
   - 商品明细页顶部有「全部商品税率」工具条(`applyTaxAll`): 输入税率应用到全部行 / 只填空白行 / 检测到的税率 / 全部 0% / 清空。
   - 中间的模型明细表也有「税%」列和「全部商品税率」设置。
   - 这一批(第 3 页、工具条、中间税率列)只通过了 tsc、bun test、build, **还没有在浏览器里目视检查过**, 请先打开几张收据确认布局。
4. 其他: 图片缓存问题(`/api/image/:id` 改为 no-cache + ETag, 前端 URL 带 `?v=importedAt`)、数据库重置命令、去掉迁移备份。
5. 项目里原本就有: 标准答案对照(server/lib/truth.ts)、按识别来源的准确度统计和校准(analytics.ts)、审计日志、快捷键、重复导入检测(文件 SHA-1)。不用重做。

## 还没做 / 建议的下一步
- 在界面里目视检查上面第 3 点的新布局(窄屏、中英文切换、只读状态)。
- 让模型读收据底部的税率汇总(SR 6%、ZRL 0%), 把行上的字母代码对应成税率(目前 `rateOf` 只认百分号和零税率代码, SR/S/T 不猜)。
- 「商品代码」字段(例如 OTC-000127 这类 SKU, AutoCount 的 ItemCode): 现在会被并进商品名。若要加, 沿用 uom/discount/taxRate 的同一条数据通路。
- 字段级风险分、第二个识别服务只在对账失败时才调用(省时间)。
- 把 Kaggle 笔记本里的 Python 版对账规则同步新的 `items_tax_incl` 和 `tax_by_rate`(Python 版和 TS 版靠 shared/recon-cases.json 约束)。
- AutoCount 导出: 先查 AutoCount 知识库里采购发票/现金簿需要的必填字段, 再定第一版导出格式。写入必须先预览、再由用户确认。
- 评测集: 用 truth.ts 的标准答案 CSV 导入真实收据, 看 MiniCPM / GLM-OCR / 开启 `MINICPM_ITEM_DETAILS` 前后的准确度。

## 完整优化清单(按方向, 前面「建议的下一步」是其中最优先的几项)
以下都只是计划, 都还没做; 效果幅度需要用评测集实测, 不要提前承诺数字。

准确度
- 图片预处理: 自动纠偏、裁边、提亮对比度(热敏纸褪色), 已有 sharp 可用。
- 约束输出格式: llama.cpp 的语法 / JSON schema 约束, 减少坏 JSON 和漏字段, 少走一遍「抢救解析」。
- 局部重读: 某个字段(如总额)对账失败时, 把那块区域裁出来放大再读一次, 比整张重跑便宜。
- 温度 0 + 固定随机种子, 保证同一张图每次结果一致。
- 字段级置信度: 综合「两个模型是否一致」和「对账是否通过」给每个字段风险分, 自动通过只看这个分数。
- 对账容差用评测数据校准(现在的 0.026 等是按理论定的)。
- 日期合理性: 未来日期、日期与税制对不上(例如 2019 年的收据却有 GST 6%)标红。
- GST/SST 登记号格式检查; 文莱收据判断要结合地址、+673 电话区号, 不能只看 `$` 符号。
- e-Invoice 二维码 / UUID 交叉验证(没核实过收据上是否普遍有, 先调查)。

速度与稳定
- 第二个识别服务只在第一个对账失败时才调用。
- Kaggle 网关会话级固定路由(同一张收据的请求固定发到同一块 T4)。
- 批量任务断点续跑; Kaggle / 隧道掉线后自动重连, 从中断处继续。
- 按图片哈希缓存识别结果, 同一张图再导入直接复用。
- 评测: 用真实收据做回归测试集(golden fixtures), 每次改识别/对账逻辑都自动跑。
- 监控: 每张耗时、自动通过率、被人工改动的比例。
- 部署: 目前是 Kaggle + 隧道 + 单机 SQLite 无登录, 给客户长期用需要固定服务和登录/权限。

重复与数据质量
- 重复检测增强: 「商家 + 日期 + 总额 + 单号」组合, 或图片相似度(现在只有文件 SHA-1, 重新拍一张就查不出)。
- 环境变量 `PORTAL_ALLOW_DUP_SCAN` 开关(允许对同一张图重复扫描)。
- 商家记忆: 按商家记住含税/不含税、币种、日期格式、常见税率、常用科目; 同一商家不同写法合并成一个。
- 「只有一个模型读过」的标记(没有第二意见的收据要让审核员看得出)。

审核体验
- 按风险排队(先审最可疑的)、批量通过高置信度的、不一致字段单独高亮。
- 税率汇总表: 在商品明细页显示「各税率: 不含税金额 → 税额」。

输出与集成
- AutoCount 导出: 供应商匹配到 Creditor、商品/费用对应科目、税码映射(GST 时期 SR/ZRL, SST 时期 S-10/SV-6 等)、舍入对应舍入调整账户; 先查知识库里各单据的必填字段, 写入必须先预览再确认。
- 外币收据按当日汇率折算 MYR。
- 月度汇总: 按商家、科目、税额统计, 导出 Excel / PDF。

输入端
- 长收据分段拼接、多页 PDF、手机 HEIC 格式。
- 收据直接发 WhatsApp 入库(用户另有 WhatsApp 下单 agent 项目, 可参考)。

## 马来西亚/文莱/AutoCount 规则研究
已整理成文档(Claude Docs): https://claude.ai/artifact/7VxMqa5gjjbuWQFwZLww45
要点: 2018-05-31 及以前 GST 6%, 2018-06-01 至 08-31 为 0%, 2018-09-01 起 SST; 舍入只作用在整张账单含税总额(调整额只可能是 −0.02…+0.02);
多税率收据按税率分组算税; 文莱没有 VAT/GST/销售税。文档第十节列了没有核实的地方。

## 没有验证过的东西
- GLM-OCR 在 Kaggle 上的实际效果、Jev 阈值、`MINICPM_ITEM_DETAILS=on` 对准确度的影响。
- 模型(Kaggle + cloudflared)是临时环境, 隧道会过期; portal 是单机 SQLite, 没有登录, 只适合内部试用。
