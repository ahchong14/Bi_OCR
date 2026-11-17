#!/usr/bin/env python3
"""清理门户里的测试数据(收据、商品明细、审核记录、图片)。

默认只"预览": 列出会删什么,什么都不改。加 --execute 才真的删,删之前会先备份数据库。

用法(在 receipt-portal 目录下运行,先关掉门户再运行):
  python clean_portal_data.py --all                          预览: 全部收据
  python clean_portal_data.py --all --execute                真的清空
  python clean_portal_data.py --batch ocr.space --execute    只删批次名里含 "ocr.space" 的(可重复写多个 --batch)
  python clean_portal_data.py --state pending --execute      只删还没审核的
  python clean_portal_data.py --before 2026-11-03 --execute  只删导入时间早于这天的
  python clean_portal_data.py --ids 3 5 8 --execute          只删这几个编号
  python clean_portal_data.py --list-batches                 看有哪些批次、各多少张

多个筛选条件同时写 = 必须全部满足才删(取交集)。
默认保留标准答案表(ground_truth,SROIE 之类的对照数据);要一起清掉加 --ground-truth。
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime


def connect(db_path: str) -> sqlite3.Connection:
    if not os.path.exists(db_path):
        sys.exit(f'找不到数据库: {db_path}(用 --data 指定数据目录)')
    con = sqlite3.connect(db_path, timeout=10)
    con.execute('PRAGMA foreign_keys = ON')  # 删收据时自动带走商品明细和 receipt_blobs
    return con


def build_where(a: argparse.Namespace) -> tuple[str, list]:
    """把命令行的筛选条件拼成 WHERE 子句(全部用参数绑定,不拼接用户输入)。"""
    parts: list[str] = []
    args: list = []
    for b in a.batch or []:
        parts.append('batch LIKE ?')
        args.append(f'%{b}%')
    if a.state:
        parts.append('state = ?')
        args.append(a.state)
    if a.status:
        parts.append('pipeline_status = ?')
        args.append(a.status)
    if a.before:
        parts.append('imported_at < ?')
        args.append(a.before)
    if a.ids:
        parts.append(f'id IN ({",".join("?" * len(a.ids))})')
        args.extend(a.ids)
    return (' AND '.join(parts) if parts else '1=1'), args


def main() -> None:
    p = argparse.ArgumentParser(description='清理门户里的测试数据(默认只预览)')
    p.add_argument('--data', default='data', help='门户数据目录,默认 ./data')
    p.add_argument('--all', action='store_true', help='选中全部收据')
    p.add_argument('--batch', action='append', help='批次名里包含这段文字的(可重复)')
    p.add_argument('--state', choices=['pending', 'approved', 'rejected'], help='审核状态')
    p.add_argument('--status', help='系统判定,如 AUTO_VERIFIED / REVIEW')
    p.add_argument('--before', help='导入时间早于这个日期(YYYY-MM-DD)')
    p.add_argument('--ids', type=int, nargs='+', help='指定收据编号')
    p.add_argument('--ground-truth', action='store_true', help='同时清空标准答案表')
    p.add_argument('--keep-audit', action='store_true', help='保留审核记录(默认会一起删掉这些收据的记录)')
    p.add_argument('--keep-images', action='store_true', help='只删数据库记录,不删图片文件')
    p.add_argument('--list-batches', action='store_true', help='列出批次和数量后退出')
    p.add_argument('--execute', action='store_true', help='真的执行(不加就只预览)')
    a = p.parse_args()

    db_path = os.path.join(a.data, 'portal.db')
    con = connect(db_path)

    if a.list_batches:
        for batch, n in con.execute('SELECT batch, COUNT(*) FROM receipts GROUP BY batch ORDER BY MIN(imported_at)'):
            print(f'{n:5d}  {batch}')
        return

    # 一个筛选条件都不写就拒绝,避免手滑清空
    if not (a.all or a.batch or a.state or a.status or a.before or a.ids):
        sys.exit('请指定要删哪些: --all,或 --batch / --state / --status / --before / --ids。先用 --list-batches 看看有什么。')

    where, args = build_where(a)
    rows = con.execute(f'SELECT id, file, image, state, batch FROM receipts WHERE {where}', args).fetchall()
    total = con.execute('SELECT COUNT(*) FROM receipts').fetchone()[0]
    ids = [r[0] for r in rows]

    print(f'数据库: {os.path.abspath(db_path)}')
    print(f'收据总数 {total} 张,选中 {len(rows)} 张' + ('' if a.execute else '  [预览,不会改任何东西]'))
    by_state: dict[str, int] = {}
    for r in rows:
        by_state[r[3]] = by_state.get(r[3], 0) + 1
    for k, v in sorted(by_state.items()):
        print(f'  {k}: {v}')
    for r in rows[:10]:
        print(f'  #{r[0]:<5} {r[3]:9} {r[1]}')
    if len(rows) > 10:
        print(f'  ... 还有 {len(rows) - 10} 张')
    n_audit = con.execute(f'SELECT COUNT(*) FROM audit WHERE receipt_id IN (SELECT id FROM receipts WHERE {where})', args).fetchone()[0]
    n_gt = con.execute('SELECT COUNT(*) FROM ground_truth').fetchone()[0]
    print(f'关联的审核记录 {n_audit} 条' + ('(保留)' if a.keep_audit else '(会一起删)'))
    print(f'标准答案表 {n_gt} 行' + ('(会清空)' if a.ground_truth else '(保留)'))

    if not a.execute:
        print('\n确认没问题后,加 --execute 再运行一次。')
        return
    if not rows and not a.ground_truth:
        print('没有要删的。')
        return

    # 1. 先备份数据库(只备份库;图片文件不备份,太大)。用 SQLite 自带的备份接口,开着门户也能得到一致的副本
    backup = os.path.join(a.data, f'portal.db.before-clean-{datetime.now():%Y%m%d-%H%M%S-%f}.bak')
    dst = sqlite3.connect(backup)
    con.backup(dst)
    dst.close()
    print(f'\n已备份数据库 → {backup}')

    # 2. 记下这些收据的图片文件名,稍后判断能不能删
    images = {os.path.basename(r[2]) for r in rows if r[2]}

    # 3. 删库里的数据: 审核记录要先手动删(audit 的外键是"置空",不删的话会留下孤儿记录)
    with con:
        if ids:
            if not a.keep_audit:
                con.execute(f'DELETE FROM audit WHERE receipt_id IN (SELECT id FROM receipts WHERE {where})', args)
            con.execute(f'DELETE FROM receipts WHERE {where}', args)  # receipt_items / receipt_blobs 靠外键级联一起删
        if a.ground_truth:
            con.execute('DELETE FROM ground_truth')
    left = con.execute('SELECT COUNT(*) FROM receipts').fetchone()[0]
    if left == 0:  # 全空了就让编号从 1 重新开始
        with con:
            con.execute("DELETE FROM sqlite_sequence WHERE name IN ('receipts','receipt_items','audit')")

    # 4. 删图片: 只删"已经没有任何收据在用"的文件(同一张图可能被多条记录引用)
    removed = 0
    if images and not a.keep_images:
        still_used = {os.path.basename(r[0]) for r in con.execute('SELECT image FROM receipts WHERE image IS NOT NULL')}
        for name in images - still_used:
            path = os.path.join(a.data, 'images', name)
            try:
                os.remove(path)
                removed += 1
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f'  图片没删掉 {name}: {e}')

    con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    con.execute('VACUUM')  # 收回空间
    con.close()
    print(f'已删除收据 {len(ids)} 张,图片文件 {removed} 个。剩余收据 {left} 张。')
    print('出问题可以恢复: 关掉门户,用上面的备份文件替换 portal.db(图片文件无法恢复)。')


if __name__ == '__main__':
    main()
