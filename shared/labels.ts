import type { FieldKey, Lang } from './types'

/** 字段名称(中英文)。前后端共用,服务端错误提示和 CSV 表头、前端界面都从这里取。 */
export const FIELD_LABELS: Record<Lang, Record<FieldKey, string>> = {
  zh: {
    merchant: '商家', date: '日期', currency: '币种', subtotal: '小计', discount: '折扣', service_charge: '服务费', tax: '税额',
    tip: '小费', fees: '其他费用', rounding: '舍入', total: '总额', paid: '实付', change: '找零', items: '商品明细',
  },
  en: {
    merchant: 'Merchant', date: 'Date', currency: 'Currency', subtotal: 'Subtotal', discount: 'Discount', service_charge: 'Service charge', tax: 'Tax',
    tip: 'Tip', fees: 'Other fees', rounding: 'Rounding', total: 'Total', paid: 'Paid', change: 'Change', items: 'Line items',
  },
}
