import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 数据库迁移列表。以后改表结构只需要在末尾追加一条,启动时会按 PRAGMA user_version 自动升级。
 * 设计要点: 收据的"当前值"直接放在列里(而不是只存 JSON),这样统计分析可以直接用 SQL 聚合;
 * machine 保存流水线原始识别结果,用来对比人工到底改了什么。
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file TEXT NOT NULL,
    img_hash TEXT,
    image TEXT,
    batch TEXT,
    imported_at TEXT NOT NULL,
    pipeline_status TEXT NOT NULL,
    priority INTEGER NOT NULL,
    reasons TEXT NOT NULL DEFAULT '[]',
    machine TEXT NOT NULL,
    corrections TEXT NOT NULL DEFAULT '[]',
    suggestions TEXT NOT NULL DEFAULT '[]',
    verifier TEXT,
    regex_total REAL,
    suggested_total REAL,
    ocr_text TEXT,
    timing TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
    merchant TEXT, date TEXT, currency TEXT,
    subtotal REAL, discount REAL, service_charge REAL, tax REAL, rounding REAL, total REAL,
    items TEXT NOT NULL DEFAULT '[]',
    edited_fields TEXT NOT NULL DEFAULT '[]',
    reviewer TEXT,
    reviewed_at TEXT,
    note TEXT,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_receipts_queue ON receipts(state, priority, id);
  CREATE INDEX idx_receipts_hash ON receipts(img_hash);
  CREATE INDEX idx_receipts_date ON receipts(date);
  CREATE INDEX idx_receipts_merchant ON receipts(merchant);

  CREATE TABLE receipt_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty REAL,
    price REAL
  );
  CREATE INDEX idx_items_receipt ON receipt_items(receipt_id);

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
    ts TEXT NOT NULL,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_audit_receipt ON audit(receipt_id, id);
  CREATE INDEX idx_audit_ts ON audit(ts);
  `,
  // v2: 小费、其他费用、实付、找零(用于对账算法的付款核对)
  `
  ALTER TABLE receipts ADD COLUMN tip REAL;
  ALTER TABLE receipts ADD COLUMN fees REAL;
  ALTER TABLE receipts ADD COLUMN paid REAL;
  ALTER TABLE receipts ADD COLUMN change REAL;
  `,
  // v3: 体积大、列表和统计用不到的字段(机器原始结果、OCR 原文…)拆到单独的表,主表的行变小,翻页/统计/排序明显更快;并补齐常用排序和筛选的索引
  `
  CREATE TABLE receipt_blobs (
    receipt_id INTEGER PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE,
    machine TEXT NOT NULL DEFAULT '{}',
    corrections TEXT NOT NULL DEFAULT '[]',
    suggestions TEXT NOT NULL DEFAULT '[]',
    verifier TEXT,
    ocr_text TEXT,
    timing TEXT
  );
  INSERT INTO receipt_blobs(receipt_id, machine, corrections, suggestions, verifier, ocr_text, timing)
    SELECT id, machine, corrections, suggestions, verifier, ocr_text, timing FROM receipts;
  ALTER TABLE receipts DROP COLUMN machine;
  ALTER TABLE receipts DROP COLUMN corrections;
  ALTER TABLE receipts DROP COLUMN suggestions;
  ALTER TABLE receipts DROP COLUMN verifier;
  ALTER TABLE receipts DROP COLUMN ocr_text;
  ALTER TABLE receipts DROP COLUMN timing;
  CREATE INDEX idx_receipts_recent ON receipts((COALESCE(reviewed_at, imported_at)), id);
  CREATE INDEX idx_receipts_cur_total ON receipts(currency, total);
  CREATE INDEX idx_receipts_reviewer ON receipts(reviewer);
  CREATE INDEX idx_receipts_total ON receipts(total);
  CREATE INDEX idx_receipts_dup ON receipts(date, total);
  CREATE INDEX idx_receipts_state_status ON receipts(state, pipeline_status);
  `,
  // v4: 记录每张收据是「逐张审核」还是「批量通过」的。批量通过没有逐张看过,不能算作"人工确认系统是对的",统计分析要把它排除在外
  `
  ALTER TABLE receipts ADD COLUMN review_mode TEXT;
  UPDATE receipts SET review_mode = (
    SELECT CASE WHEN json_extract(a.detail, '$.bulk') = 1 THEN 'bulk' ELSE 'single' END
      FROM audit a WHERE a.receipt_id = receipts.id AND a.action IN ('approve', 'reject') ORDER BY a.id DESC LIMIT 1
  ) WHERE state != 'pending';
  CREATE INDEX idx_receipts_mode ON receipts(review_mode);
  `,
  // v5: 标准答案(用来直接衡量识别准不准,不依赖"人工有没有改")
  `
  CREATE TABLE ground_truth (
    file TEXT PRIMARY KEY,
    company TEXT,
    date TEXT,
    address TEXT,
    total REAL,
    raw_total TEXT,
    raw_date TEXT,
    imported_at TEXT NOT NULL
  );
  `,
  // v6: 识别出的文字框(审核页在图上画框,点一下把值填进字段)
  `
  ALTER TABLE receipt_blobs ADD COLUMN boxes TEXT;
  `,
  // v7: 商品明细加「单位」和「这一行的折扣」(完整明细仍存在 receipts.items 里,这张表给导出/查询用)
  `
  ALTER TABLE receipt_items ADD COLUMN uom TEXT;
  ALTER TABLE receipt_items ADD COLUMN discount REAL;
  `,
  // v8: 商家记忆表(模型读到的商家名 → 审核员确认的商家名),见 server/lib/aliases.ts
  `
  CREATE TABLE merchant_alias (
    alias_norm TEXT NOT NULL,
    alias TEXT NOT NULL,
    canonical TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (alias_norm, canonical)
  );
  `,
  // v9: 第二意见(按需升级): 状态放在 receipts(列表要显示徽章),结果 JSON 放在 receipt_blobs(体积大,只有打开详情才读)
  `
  ALTER TABLE receipts ADD COLUMN second_state TEXT;
  ALTER TABLE receipt_blobs ADD COLUMN second TEXT;
  CREATE INDEX idx_receipts_second ON receipts(second_state);
  `,
  // v10: 单据分类(见 IMPLEMENTATION-PLAN.md)。旧的列不动,仍是通用的扁平视图;新列都可空,旧数据不回填(document_type 为 NULL = 没分类过)。
  //   列表要用的(筛选 / 显示)放在 receipts: 类型、方向、分类把握度、单据号、标题、人工是否改过分类;
  //   完整的文档信息 JSON(对方、表头、付款、关键词、证据 …)放在 receipt_blobs.doc,体积大,只有打开详情才读。
  `
  ALTER TABLE receipts ADD COLUMN document_type TEXT;
  ALTER TABLE receipts ADD COLUMN direction TEXT;
  ALTER TABLE receipts ADD COLUMN type_confidence REAL;
  ALTER TABLE receipts ADD COLUMN doc_no TEXT;
  ALTER TABLE receipts ADD COLUMN title TEXT;
  ALTER TABLE receipts ADD COLUMN doc_edited INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE receipt_blobs ADD COLUMN doc TEXT;
  CREATE INDEX idx_receipts_type ON receipts(document_type, direction);
  CREATE INDEX idx_receipts_docno ON receipts(doc_no);
  `,
]

export function openDb(dataDir: string): Database {
  mkdirSync(join(dataDir, 'images'), { recursive: true })
  const db = new Database(join(dataDir, 'portal.db'), { create: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  if (current > 0 && current < 3) db.exec('VACUUM') // 拆表后回收空间
  return db
}

/** 本地时间的 ISO 字符串(不带时区),按天统计时符合员工的直觉。 */
export function nowLocal(): string {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}
