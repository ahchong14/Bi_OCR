/**
 * 「我方身份」(可选配置,IMPLEMENTATION-PLAN D4): 用来判断一张单据是我们开出去的(销售方向)还是别人开给我们的(采购方向)。
 * 图片上没有这个信息,所以只能靠配置;没配置时方向保持 unknown(收据这类天然只有一个方向的类型除外),开单方和对方照常输出,
 * 由调用方(它自己知道自己是谁)决定。
 *
 * 环境变量(都可选,多个值用 | 隔开):
 *   OUR_COMPANY_NAMES    公司名和别名,如 "OUR TRADING SDN BHD|OUR TRADING"
 *   OUR_COMPANY_REG_NOS  注册号
 *   OUR_COMPANY_TAX_IDS  税号(GST / SST / TIN)
 */
import type { DocParty } from '../../shared/doc'
import { partyKey } from './docchecks'

export interface OurCompany { names: string[]; regNos: string[]; taxIds: string[] }

/** 全局配置(index.ts 启动时按环境变量设置)。null = 没配置我方身份。 */
export const ourCompanyOpts: { company: OurCompany | null } = { company: null }

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
const list = (v: string | undefined): string[] => (v ?? '').split('|').map((x) => x.trim()).filter(Boolean)

/** 三个都没配置 → null(没有「我方身份」)。 */
export function parseOurCompany(env: Record<string, string | undefined>): OurCompany | null {
  const c: OurCompany = { names: list(env.OUR_COMPANY_NAMES), regNos: list(env.OUR_COMPANY_REG_NOS), taxIds: list(env.OUR_COMPANY_TAX_IDS) }
  return c.names.length || c.regNos.length || c.taxIds.length ? c : null
}

/** 这一方是不是我们。税号 / 注册号精确命中优先;名字规整后(去 SDN BHD、标点、大小写)相等,或者一个完整包含另一个(≥ 6 个字符)。 */
export function isUs(party: Pick<DocParty, 'name_as_printed' | 'reg_no' | 'tax_id'> | null | undefined, our: OurCompany | null): boolean {
  if (!party || !our) return false
  const tax = alnum(party.tax_id ?? '')
  if (tax && our.taxIds.some((x) => alnum(x) === tax)) return true
  const reg = alnum(party.reg_no ?? '')
  if (reg && our.regNos.some((x) => alnum(x) === reg)) return true
  const name = partyKey(party.name_as_printed)
  if (!name) return false
  return our.names.some((n) => {
    const k = partyKey(n)
    if (!k) return false
    if (k === name) return true
    const [a, b] = k.length <= name.length ? [k, name] : [name, k]
    return a.length >= 6 && b.includes(a)
  })
}
