import { FIELD_LABELS } from '../../shared/labels'
import type { FieldKey, Lang, ReviewState } from '../../shared/types'

type P = Record<string, string | number>

/** 请求头 x-lang 优先,其次 Accept-Language;都没有时默认中文。 */
export function parseLang(xLang: string | null | undefined, accept?: string | null): Lang {
  const v = (xLang ?? accept ?? '').toLowerCase()
  return v.startsWith('en') ? 'en' : 'zh'
}

const f = (lang: Lang, k: string | number | undefined) => FIELD_LABELS[lang][k as FieldKey] ?? String(k ?? '')

/** 服务端所有会显示给员工的提示。每条都有中英文两个版本。 */
const MESSAGES: Record<string, { zh: (p: P) => string; en: (p: P) => string }> = {
  USER_REQUIRED: { zh: () => '请先在右上角填写审核人姓名', en: () => 'Please enter your name in the top-right corner first' },
  RECEIPT_NOT_FOUND: { zh: () => '找不到这张收据', en: () => 'Receipt not found' },
  SECOND_DISABLED: { zh: () => '没有开启第二个读取模型(设置 MINICPM2_URL,并且 SECOND_MODE 不是 off)', en: () => 'The second reader is not enabled (set MINICPM2_URL and SECOND_MODE is not off)' },
  SECOND_ALREADY_QUEUED: { zh: () => '这张收据已经在第二意见的队列里', en: () => 'This receipt is already in the second-opinion queue' },
  API_NOT_FOUND: { zh: () => '没有这个接口', en: () => 'Unknown API endpoint' },
  IMAGE_NOT_FOUND: { zh: () => '没有图片', en: () => 'No image for this receipt' },
  VERSION_CONFLICT: { zh: () => '这张收据刚刚被其他人修改过,请刷新后再操作', en: () => 'Someone else just changed this receipt. Please refresh and try again' },
  FINAL_MISSING: { zh: () => '缺少要保存的内容', en: () => 'Nothing to save' },
  APPROVE_NEEDS_FIELDS: { zh: () => '通过前请填写「商家」和「总额」', en: () => 'Please fill in "Merchant" and "Total" before approving' },
  REJECT_NEEDS_NOTE: { zh: () => '驳回时请写明原因,方便提交人修改', en: () => 'Please give a reason when rejecting so the submitter can fix it' },
  DATE_FORMAT: { zh: () => '日期格式应为 年-月-日,例如 2018-06-17', en: () => 'Date must be YYYY-MM-DD, for example 2018-06-17' },
  AMOUNT_INVALID: { zh: (p) => `「${f('zh', p.field)}」不是有效的金额`, en: (p) => `"${f('en', p.field)}" is not a valid amount` },
  AMOUNT_RANGE: { zh: (p) => `「${f('zh', p.field)}」的金额大得不合理,请检查是否多输了数字`, en: (p) => `"${f('en', p.field)}" is unreasonably large. Please check for extra digits` },
  SCAN_DISABLED: { zh: () => '这台服务器关闭了扫描功能(PORTAL_SCAN=off)', en: () => 'Scanning is turned off on this server (PORTAL_SCAN=off)' },
  SCAN_RATE_LIMIT: { zh: () => '识别服务的额度或频率限制到了,请稍后再试(Anthropic 控制台可以查看用量和额度)', en: () => 'The OCR service limit was reached. Try again later (usage and limits are shown in the Anthropic Console)' },
  SCAN_AUTH: { zh: () => '识别服务拒绝了密钥,请检查服务器环境变量 ANTHROPIC_API_KEY', en: () => 'The OCR service rejected the key. Check the ANTHROPIC_API_KEY environment variable on the server' },
  SCAN_TOO_BIG: { zh: () => '图片太大,缩小后仍超过识别服务的限制', en: () => 'The image is still too large for the OCR service after resizing' },
  SCAN_TIMEOUT: { zh: () => '识别服务响应太慢,已超时,请重试', en: () => 'The OCR service timed out. Please retry' },
  SCAN_NETWORK: { zh: () => '连不上识别服务(Anthropic API),请检查服务器的网络', en: () => 'Cannot reach the OCR service (Anthropic API). Check the server network' },
  SCAN_UPSTREAM: { zh: () => '识别服务出错了,请稍后重试', en: () => 'The OCR service returned an error. Please retry later' },
  TRUTH_BAD_FORMAT: { zh: () => '标准答案文件格式不对:需要 CSV,第一行是表头,至少有 file 列,以及 company / date / total 中的一列', en: () => 'Wrong ground-truth file: expected a CSV with a header row, a "file" column and at least one of company / date / total' },
  ITEM_INVALID: { zh: (p) => `第 ${p.n} 行商品的数量或金额不是有效的数字`, en: (p) => `Line item ${p.n}: quantity or amount is not a valid number` },
  HOST_FORBIDDEN: { zh: () => '不允许的访问地址', en: () => 'This address is not allowed' },
  REQUEST_FORBIDDEN: { zh: () => '非法请求', en: () => 'Request rejected' },
  TOKEN_REQUIRED: { zh: () => '需要口令', en: () => 'Access token required' },
  ZIP_INVALID: { zh: () => '这不是有效的压缩包', en: () => 'This is not a valid zip file' },
  ZIP_NO_RESULTS: { zh: () => '压缩包里没有 receipts_result.json,请上传流水线导出的 portal_package.zip', en: () => 'No receipts_result.json in the zip. Please upload the portal_package.zip exported by the pipeline' },
  RESULTS_JSON_INVALID: { zh: () => 'receipts_result.json 不是有效的 JSON', en: () => 'receipts_result.json is not valid JSON' },
  RESULTS_BAD_FORMAT: { zh: () => 'receipts_result.json 格式不对,应为结果列表', en: () => 'receipts_result.json has the wrong format; expected a list of results' },
  JSON_BAD_FORMAT: { zh: () => 'JSON 格式不对,应为结果列表', en: () => 'Wrong JSON format; expected a list of results' },
  FILE_EMPTY_OR_TOO_BIG: { zh: () => '文件为空或超过大小上限', en: () => 'The file is empty or too large' },
  IMAGE_EMPTY_OR_TOO_BIG: { zh: () => '图片为空或太大', en: () => 'The image is empty or too large' },
  IMAGE_TOO_BIG: { zh: (p) => `图片太大:${p.name}`, en: (p) => `Image too large: ${p.name}` },
  IMAGE_UNSUPPORTED: { zh: (p) => `不支持的图片格式:${p.name}(请使用 jpg / png / webp)`, en: (p) => `Unsupported image format: ${p.name} (use jpg / png / webp)` },
  FILENAME_MISSING: { zh: () => '缺少文件名', en: () => 'File name is missing' },
  TYPE_NOT_ENABLED: { zh: (p) => `不认识的单据类型:${p.type}(用 GET /v2/types 查看可用的类型)`, en: (p) => `Unknown document type: ${p.type} (see GET /v2/types for the available types)` },
  VALIDATION: { zh: () => '提交的数据格式不正确', en: () => 'The submitted data is invalid' },
  PARSE: { zh: () => '无法解析提交的内容', en: () => 'Could not parse the request body' },
  SERVER_ERROR: { zh: () => '服务器出错了,请稍后重试', en: () => 'Server error. Please try again later' },
  FRONTEND_NOT_BUILT: { zh: () => '前端还没有构建,请先运行: bun run build', en: () => 'The frontend has not been built yet. Run: bun run build' },
}

export function serverMessage(code: string, lang: Lang, params: P = {}): string {
  const m = MESSAGES[code]
  return m ? m[lang](params) : code
}

// ---- CSV 导出用 ----
const STATE: Record<Lang, Record<ReviewState, string>> = {
  zh: { pending: '待审核', approved: '已通过', rejected: '已驳回' },
  en: { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' },
}
export const stateLabel = (lang: Lang, s: ReviewState) => STATE[lang][s]
export const fieldLabel = (lang: Lang, k: string) => f(lang, k)
export const yesNo = (lang: Lang, v: boolean) => (lang === 'zh' ? (v ? '是' : '否') : v ? 'Yes' : 'No')
export const listSep = (lang: Lang) => (lang === 'zh' ? '、' : ', ')

export const CSV_HEADERS: Record<Lang, { receipts: string[]; items: string[] }> = {
  zh: {
    receipts: ['文件', '商家', '日期', '币种', '小计', '折扣', '服务费', '税额', '小费', '其他费用', '舍入', '总额', '实付', '找零', '商品数', '状态', '审核人', '审核时间', '是否人工修改', '修改的字段', '系统初判', '备注'],
    items: ['文件', '商家', '日期', '币种', '商品', '数量', '单位', '折扣', '税率%', '金额'],
  },
  en: {
    receipts: ['File', 'Merchant', 'Date', 'Currency', 'Subtotal', 'Discount', 'Service charge', 'Tax', 'Tip', 'Other fees', 'Rounding', 'Total', 'Paid', 'Change', 'Items', 'Status', 'Reviewer', 'Reviewed at', 'Edited by human', 'Edited fields', 'System verdict', 'Note'],
    items: ['File', 'Merchant', 'Date', 'Currency', 'Item', 'Qty', 'UOM', 'Discount', 'Tax %', 'Amount'],
  },
}
