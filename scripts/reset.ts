/**
 * 清空数据: `bun run reset`(先停掉门户)。
 * 数据目录和门户用同一个规则: 环境变量 PORTAL_DATA,没设就是项目里的 data 文件夹。
 * 只删这几样,别的文件不碰: 数据库(portal.db 和它的 -wal / -shm / 旧版本留下的 .bak)、images 文件夹(收据原图)。
 * 下次启动门户会自动建一个全新的空数据库,编号从 1 重新开始。
 */
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dataDir = resolve(process.env.PORTAL_DATA ?? join(import.meta.dir, '..', 'data'))
console.log(`数据目录: ${dataDir}`)
if (!existsSync(dataDir)) { console.log('这个目录不存在,没有东西可清。'); process.exit(0) }

const targets = readdirSync(dataDir).filter((n) => n === 'images' || /^portal\.db(-wal|-shm|\..*\.bak)?$/.test(n))
try {
  for (const n of targets) { rmSync(join(dataDir, n), { recursive: true, force: true }); console.log(`已删除 ${n}`) }
} catch (e) {
  console.error(`删除失败: ${(e as Error).message}\n数据库可能还被门户占着: 请先停掉门户(在运行它的窗口按 Ctrl+C),再重新执行。`)
  process.exit(1)
}
mkdirSync(join(dataDir, 'images'), { recursive: true })
console.log(targets.length ? '清空完成。重新启动门户即可(浏览器按 Ctrl+F5)。' : '数据目录里本来就是空的。')
