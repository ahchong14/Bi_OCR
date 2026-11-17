import { describe, expect, test } from 'bun:test'
import { cleanData } from '../lib/clean'
import { salvageLineItems, modelItemRows } from '../../shared/items'

describe('商品明细: 单位 / 这一行的折扣', () => {
  test('清洗: 有 uom / discount 就保留,没有就不带这两个键', () => {
    const d = cleanData({ items: [{ name: 'A', qty: 2, price: '10.00', uom: ' kg ', discount: '1.50' }, { name: 'B', qty: 1, price: 3 }] }, false)
    expect(d.items[0]).toEqual({ name: 'A', qty: 2, price: 10, uom: 'kg', discount: 1.5 })
    expect(Object.keys(d.items[1]!)).toEqual(['name', 'qty', 'price'])
  })
  test('坏 JSON 抢救: amount 后面的 uom / discount 一起捞出来,没有也照样匹配', () => {
    const s = '{"line_items":[{"description":"6"HT pipe","quantity":"2","unit_price":"5.00","amount":"10.00","uom":"pcs","discount":"1.00"},{"description":"nut","quantity":"1","unit_price":"1.00","amount":"1.00"}]}'
    const r = salvageLineItems(s)
    expect(r.length).toBe(2)
    expect(r[0]).toMatchObject({ uom: 'pcs', discount: '1.00', amount: '10.00' })
    expect('uom' in r[1]!).toBe(false)
  })
  test('明细表格行带 uom / discount', () => {
    const t = '[line items]\n{"line_items":[{"description":"a","quantity":"1","unit_price":"2","amount":"2","uom":"kg","discount":"###"}]}'
    expect(modelItemRows(t).rows[0]).toMatchObject({ uom: 'kg', discount: '' })
  })
})
