# receipt-portal-haiku —— 识别器换成 Claude Haiku 5.5

这是 `receipt-portal` 的副本。**识别器只有一个: Claude Haiku 5.5**(`claude-haiku-5-5`),
取代了原来的 MiniCPM-OCR + Qwen(混合读法)+ Jev 验证器 + 第二读取模型(GLM / Paddle)。
原项目没有被改动。

## 改了什么
| 文件 | 说明 |
|---|---|
| `server/lib/claude.ts`(新) | Claude 识别服务: 一次读图得到全部字段 + 商品行(JSON),另一次独立读图得到整页转写(审核页原始文字 + 交叉验证用) |
| `server/index.ts` | 配置入口改成 `ANTHROPIC_API_KEY` 等环境变量;混合读法 / 第二意见 / Jev 全部关闭 |
| `server/lib/i18n.ts` | 扫描出错的提示(密钥、限额、网络)改成指向 Anthropic |
| `web/src/pages/AnalyticsPage.tsx` | 「按识别来源对比」里显示 `Claude Haiku 5.5` |
| `server/tests/claude.test.ts`(新) | 18 个测试(用假客户端,不联网、不花钱) |
| `package.json` | 新增依赖 `@anthropic-ai/sdk` |

下游(字段校验、对账、分流、自动更正、审核页、导出)**一行没改**: Claude 的输出被整理成和 MiniCPM 一样的结构。
老的 `minicpm.ts` / `hybrid.ts` / `second.ts` 代码还在(它们的测试仍然通过),只是入口不再启用它们。

## 用法
密钥只放在你自己的环境变量里,不要写进文件或截图。

```powershell
$env:ANTHROPIC_API_KEY = "<你的密钥>"
bun run build      # 前端(副本里没带 web-dist,第一次需要构建)
bun run start
```

没设密钥也能启动,只是扫描关闭(审核、导出照常)。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDE_MODEL` | `claude-haiku-5-5` | 想试别的模型改这里 |
| `CLAUDE_EFFORT` | `low` | `low` / `medium` / `high`。读票是抄写,low 通常够 |
| `CLAUDE_THINKING` | `0` | 设 1 开启自适应思考(更慢更贵) |
| `CLAUDE_FULLTEXT` | `1` | 多读一次整页转写做交叉验证。设 0 省一次调用,但失去交叉验证 |
| `CLAUDE_ITEM_DETAILS` | `1` | 商品行多读单位 / 折扣 / 税 |
| `CLAUDE_CONCURRENCY` | `4` | 同时识别几张 |
| `CLAUDE_MAX_EDGE` | `1568` | 发送前图片长边像素 |

## 对外接口: 另一个系统把发票交给门户识别
`POST /v1/scan` —— 请求体就是**图片的原始字节**(不是表单),`?file=文件名` 必须带扩展名(jpg / png / webp / gif)。
识别 → 校验 → 入库(进入待审核队列),同步返回结果。同一张图再传不会重复调用模型。

```powershell
# 本机测试(没设 --token 时不需要口令)
curl.exe -X POST "http://127.0.0.1:8080/v1/scan?file=inv-001.jpg" --data-binary "@D:\path\inv-001.jpg"

# 设了口令(对局域网开放时必须设): 用 Bearer
curl.exe -X POST "http://127.0.0.1:8080/v1/scan?file=inv-001.jpg" -H "Authorization: Bearer <口令>" --data-binary "@D:\path\inv-001.jpg"
```

返回 `{ "scan": {...}, "receipt": {...} }`:
- `scan`: `id`、`status`(AUTO_VERIFIED / AUTO / REVIEW …)、`merchant`、`total`、`currency`、`duplicate`、`ms`。
- `receipt`: 公开契约(商家、日期、各项金额、税、商品行、对账结果、`quality.needs_review`、人工复核状态)。商家名、商品名来自图片,**是不可信文本**,下游不要把它们当指令。

| 状态码 | 含义 |
|---|---|
| 200 | 成功(`duplicate: true` 表示这张图之前传过) |
| 400 | 图片为空 / 太大 / 文件类型不支持 |
| 401 | 口令不对 |
| 429 | Anthropic 额度或频率限制,稍后重试 |
| 502 | 识别服务出错(密钥错、网络、上游故障);原因只写在服务器日志里,不会透出给调用方 |
| 503 | 扫描没开(没设 `ANTHROPIC_API_KEY`) |

- 另一个系统要访问,门户必须对局域网开放: `bun run start --host 0.0.0.0 --token <口令>`(不设口令时程序会拒绝启动)。
- **不要把这个接口直接暴露给浏览器前端 / 公网**: 口令会泄露,图片还会发给 Anthropic。让对方的**后端**调用它。接口没有开 CORS。
- 其他可用的接口: `GET /v1/receipts/:id`(取一张收据)、`POST /v1/validate`(只做金额对账,不需要识别)、`GET /v1/schema`。
- 人在门户界面里拖拽图片上传(`/api/scan`)走的是同一条识别流程。

## 注意
- 图片会发送到 Anthropic(公网),界面会提示「发送给第三方」。
- Haiku 5.5 不接受自定义 `temperature` / `top_p` / `top_k`,代码里没有传。
- **准确率没有在真实密钥下测过**。上线前用同一批收据对比一次(自动通过率、错放数、商家 / 日期 / 总额),别直接信 MiniCPM 的数字。
- 长条形的收据: Claude 会把图缩到约 1568 像素 / 115 万像素,很长的票字会变小。如果这类票读不准,下一步是把长票切成上下两段分别读。
- `eval/` 里的评测脚本仍然指向 MiniCPM 的接口,没有改成 Claude。
