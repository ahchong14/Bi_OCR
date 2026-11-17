/**
 * 把已经逐张审核通过的收据补学进商家记忆表(见 server/lib/aliases.ts 的 backfillAliases)。重复运行安全。
 *
 *   bun eval/backfill-aliases.ts                 # 默认 data/portal.db
 *   bun eval/backfill-aliases.ts --db data-sample
 *
 * 会写数据库(merchant_alias 表),所以运行前请先备份 data/portal.db*。门户在运行时也可以跑(SQLite WAL),但建议先停。
 */
import { join, resolve } from 'node:path'
import { openDb } from '../server/db'
import { backfillAliases, loadAliases } from '../server/lib/aliases'

const root = resolve(import.meta.dir, '..')
const i = process.argv.indexOf('--db')
const dir = resolve(i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : join(root, 'data'))
const db = openDb(dir)
const r = backfillAliases(db)
console.log(`逐张审核通过的收据 ${r.receipts} 张 → 新记了 ${r.learned} 条别名;记忆表现在共 ${loadAliases(db).length} 条`)
for (const a of loadAliases(db).sort((x, y) => y.hits - x.hits).slice(0, 15)) console.log(`  ${a.hits} 次  ${a.alias}  →  ${a.canonical}`)
