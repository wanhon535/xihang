import express from 'express';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function parseAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,2})?$/.test(value)) throw fail('金额须为正数，最多两位小数且不超过 999999999.99 元。');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) throw fail('金额须大于零。');
  return cents.toString();
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${label}不能为空且不能超过 ${max} 字。`);
  return value.trim();
}
export function validateEntry(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('记录参数无效。');
  const date = text(body.date, '日期', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1000-01-01' || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw fail('日期无效。');
  if (!['paid', 'unpaid'].includes(body.paymentStatus)) throw fail('付款状态无效。');
  return { date, project: text(body.project, '项目/业务', 160), category: text(body.category, '类别', 120), description: text(body.description ?? '', '说明', 1000, false), amountCents: parseAmount(body.amount), paymentStatus: body.paymentStatus, handler: text(body.handler, '经办人', 160), notes: text(body.notes ?? '', '备注', 2000, false) };
}
export function summarize(entries, month) {
  let total = 0n, current = 0n, unpaid = 0n;
  for (const row of entries) {
    const cents = BigInt(row.amountCents);
    total += cents;
    if (row.date.startsWith(month)) current += cents;
    if (row.paymentStatus === 'unpaid') unpaid += cents;
  }
  return { totalCents: String(total), monthCents: String(current), unpaidCents: String(unpaid) };
}
export function validateAttachment(input) {
  const name = text(input?.name, '附件文件名', 160);
  if (/[\\/\x00-\x1f\x7f]/.test(name)) throw fail('附件文件名无效。');
  const data = input?.data;
  if (typeof data !== 'string' || !data.length || data.length > 4 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw fail('附件需为有效 Base64，最大 3 MiB。');
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.length > 3 * 1024 * 1024) throw fail('附件最大 3 MiB。');
  let mime;
  if (/\.pdf$/i.test(name) && buffer.subarray(0, 5).toString() === '%PDF-') mime = 'application/pdf';
  if (/\.png$/i.test(name) && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
  if (/\.jpe?g$/i.test(name) && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) mime = 'image/jpeg';
  if (!mime) throw fail('仅接受文件格式匹配的 PDF、PNG、JPEG 凭证。');
  return { name, mime, buffer };
}
// 一条记录可以挂多张凭证（原来被 uk_cost_attachment_entry 唯一索引限制成 1 张，
// 导致「手动新增时只能传一个、多张互相替换」）。这里给个上限，防止单条记录无限膨胀。
export const MAX_ATTACHMENTS_PER_ENTRY = 20;
export const MAX_ATTACHMENTS_PER_REQUEST = 9;
/**
 * 解析本次请求对凭证的意图：
 *  - attachments: [...]          → 追加（配合 removeAttachmentIds 做删除）
 *  - attachment:  {...}          → 兼容旧前端：整条记录的凭证被这一张替换
 *  - removeAttachmentIds: [...]  → 删除指定凭证（可单独使用）
 */
export function attachmentPlan(body = {}) {
  let mode = 'none';
  let items = [];
  if (body.attachments !== undefined && body.attachments !== null) {
    if (!Array.isArray(body.attachments) || body.attachments.length > MAX_ATTACHMENTS_PER_REQUEST) throw fail(`一次最多上传 ${MAX_ATTACHMENTS_PER_REQUEST} 个凭证。`);
    items = body.attachments.map(validateAttachment);
    mode = 'append';
  } else if (body.attachment !== undefined && body.attachment !== null) {
    items = [validateAttachment(body.attachment)];
    mode = 'replace';
  }
  let removeIds = [];
  if (body.removeAttachmentIds !== undefined && body.removeAttachmentIds !== null) {
    if (!Array.isArray(body.removeAttachmentIds) || body.removeAttachmentIds.length > MAX_ATTACHMENTS_PER_ENTRY || body.removeAttachmentIds.some(id => !validId(String(id)))) throw fail('要删除的凭证列表无效。');
    removeIds = [...new Set(body.removeAttachmentIds.map(String))];
  }
  return { mode, items, removeIds };
}
export async function initCostLedger(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS cost_entries (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cost_date DATE NOT NULL, project VARCHAR(160) NOT NULL, category VARCHAR(120) NOT NULL,
    description VARCHAR(1000) NOT NULL DEFAULT '', amount_cents BIGINT UNSIGNED NOT NULL,
    payment_status VARCHAR(16) NOT NULL, handler VARCHAR(160) NOT NULL, notes TEXT NOT NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_by_name VARCHAR(160) NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL, updated_by_name VARCHAR(160) NOT NULL,
    version INT UNSIGNED NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_cost_date (cost_date), KEY idx_cost_project (project), KEY idx_cost_status (payment_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.query(`CREATE TABLE IF NOT EXISTS cost_attachments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, entry_id BIGINT UNSIGNED NOT NULL,
    filename VARCHAR(160) NOT NULL, mime VARCHAR(80) NOT NULL, content MEDIUMBLOB NOT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_cost_attachment_entry (entry_id),
    CONSTRAINT fk_cost_attachment_entry FOREIGN KEY (entry_id) REFERENCES cost_entries(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // 老库上还留着「一条记录只能一个凭证」的唯一索引，迁移时去掉，改成普通索引。
  const indexes = await db.query(`SHOW INDEX FROM cost_attachments WHERE Key_name='uk_cost_attachment_entry'`);
  const legacy = Array.isArray(indexes) && Array.isArray(indexes[0]) ? indexes[0] : [];
  if (legacy.length) await db.query('ALTER TABLE cost_attachments DROP INDEX uk_cost_attachment_entry, ADD KEY idx_cost_attachment_entry (entry_id)');
}
// 列表用相关子查询取凭证，而不是 LEFT JOIN：一条记录多张凭证时 JOIN 会把记录本身复制成多行。
const attachmentColumns = `(SELECT CAST(a.id AS CHAR) FROM cost_attachments a WHERE a.entry_id=e.id ORDER BY a.id LIMIT 1) AS attachmentId,
  (SELECT a.filename FROM cost_attachments a WHERE a.entry_id=e.id ORDER BY a.id LIMIT 1) AS attachmentName,
  (SELECT COUNT(*) FROM cost_attachments a WHERE a.entry_id=e.id) AS attachmentCount,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', CAST(a.id AS CHAR), 'name', a.filename, 'mime', a.mime)) FROM cost_attachments a WHERE a.entry_id=e.id) AS attachmentsJson`;
const selectEntries = `SELECT CAST(e.id AS CHAR) AS id, DATE_FORMAT(e.cost_date, '%Y-%m-%d') AS date,
  e.project, e.category, e.description, CAST(e.amount_cents AS CHAR) AS amountCents,
  e.payment_status AS paymentStatus, e.handler, e.notes,
  CAST(e.created_by AS CHAR) AS createdBy, e.created_by_name AS createdByName,
  CAST(e.updated_by AS CHAR) AS updatedBy, e.updated_by_name AS updatedByName,
  e.version, e.created_at AS createdAt, e.updated_at AS updatedAt,
  ${attachmentColumns}
  FROM cost_entries e`;
const validId = (id) => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id);
const kindOf = (name, mime) => (/pdf/i.test(String(mime || '')) || /\.pdf$/i.test(String(name || ''))) ? 'pdf' : 'image';
// DB 行 → 前端要的形状：把凭证列表统一成 attachments 数组，同时保留 attachmentId/Name（首个）向后兼容。
export function shapeEntryRow(row) {
  if (!row) return row;
  const shaped = { ...row };
  delete shaped.attachmentsJson;
  let list = [];
  if (Array.isArray(row.attachmentsJson)) list = row.attachmentsJson;
  else if (typeof row.attachmentsJson === 'string' && row.attachmentsJson) {
    try { const parsed = JSON.parse(row.attachmentsJson); if (Array.isArray(parsed)) list = parsed; } catch { list = []; }
  }
  let attachments = list
    .filter(item => item && item.id)
    .map(item => ({ id: String(item.id), name: String(item.name ?? ''), kind: kindOf(item.name, item.mime) }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  if (!attachments.length && shaped.attachmentId) {
    attachments = [{ id: String(shaped.attachmentId), name: String(shaped.attachmentName || ''), kind: kindOf(shaped.attachmentName, '') }];
  }
  shaped.attachments = attachments;
  if (!shaped.attachmentId && attachments.length) { shaped.attachmentId = attachments[0].id; shaped.attachmentName = attachments[0].name; }
  shaped.attachmentCount = Math.max(Number(shaped.attachmentCount) || 0, attachments.length);
  return shaped;
}
export function createCostRouter({ db, requireLogin, writeAudit = async () => {} }) {
  const router = express.Router();
  // Ledger is a shared, company-wide log: every logged-in account can read it
  // and record entries. Editing is restricted to the entry's own creator (or
  // an admin) in save() below, so no blanket requireAdmin gate here.
  router.use(requireLogin);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/', route(async (req, res) => {
    const [rows] = await db.query(`${selectEntries} ORDER BY e.cost_date DESC, e.id DESC`);
    const entries = rows.map(shapeEntryRow);
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    res.json({ok:true, entries, summary:summarize(entries, month), month});
  }));
  // 把本次请求的「新增 / 删除凭证」落到库里。删除先做，再判上限，最后插入。
  async function applyAttachmentPlan(connection, entryId, plan, actor) {
    const [existing] = await connection.query('SELECT id FROM cost_attachments WHERE entry_id=? ORDER BY id',[entryId]);
    const existingIds = existing.map(row => String(row.id));
    let kept = existingIds;
    if (plan.removeIds.length) {
      const removable = plan.removeIds.filter(id => existingIds.includes(id));
      if (removable.length) {
        await connection.query(`DELETE FROM cost_attachments WHERE entry_id=? AND id IN (${removable.map(() => '?').join(',')})`,[entryId,...removable]);
        kept = existingIds.filter(id => !removable.includes(id));
      }
    }
    if (plan.mode === 'replace') {
      const [file] = plan.items;
      if (kept.length === 1) {
        // 保持原行为：只替换内容、行 id 不变（凭证外链不会失效）。
        await connection.query('UPDATE cost_attachments SET filename=?,mime=?,content=?,uploaded_by=?,created_at=CURRENT_TIMESTAMP WHERE id=?',[file.name,file.mime,file.buffer,actor.id,kept[0]]);
        return;
      }
      if (kept.length) { await connection.query('DELETE FROM cost_attachments WHERE entry_id=?',[entryId]); kept = []; }
    }
    if (!plan.items.length) return;
    if (kept.length + plan.items.length > MAX_ATTACHMENTS_PER_ENTRY) {
      throw fail(`一条记录最多保留 ${MAX_ATTACHMENTS_PER_ENTRY} 个凭证（现有 ${kept.length} 个，本次再传 ${plan.items.length} 个会超限）。`);
    }
    for (const file of plan.items) {
      await connection.query('INSERT INTO cost_attachments (entry_id,filename,mime,content,uploaded_by) VALUES (?,?,?,?,?)',[entryId,file.name,file.mime,file.buffer,actor.id]);
    }
  }
  async function save(req, res, updating) {
    const entry = validateEntry(req.body);
    if (updating && (!validId(req.params.id) || !Number.isSafeInteger(req.body.version) || req.body.version < 1)) throw fail('记录 ID 或版本无效。');
    const plan = attachmentPlan(req.body);
    const actor = req.session.user;
    const actorName = String(actor.nick || actor.username || actor.id).slice(0,160);
    const connection = await db.getConnection();
    let id = req.params.id;
    let saved;
    try {
      await connection.beginTransaction();
      const values = [entry.date,entry.project,entry.category,entry.description,entry.amountCents,entry.paymentStatus,entry.handler,entry.notes];
      if (updating) {
        if (actor.role !== 'admin') {
          const [owner] = await connection.query('SELECT created_by FROM cost_entries WHERE id=?',[id]);
          if (!owner.length) throw fail('记录不存在。', 404);
          if (String(owner[0].created_by) !== String(actor.id)) throw fail('只能修改自己创建的记录。', 403);
        }
        const [result] = await connection.query(`UPDATE cost_entries SET cost_date=?,project=?,category=?,description=?,amount_cents=?,payment_status=?,handler=?,notes=?,updated_by=?,updated_by_name=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`, [...values,actor.id,actorName,id,req.body.version]);
        if (!result.affectedRows) {
          const [found] = await connection.query('SELECT id FROM cost_entries WHERE id=?',[id]);
          throw fail(found.length ? '其他人已修改此记录，请刷新后重新编辑。' : '记录不存在。', found.length ? 409 : 404);
        }
      } else {
        const [result] = await connection.query(`INSERT INTO cost_entries (cost_date,project,category,description,amount_cents,payment_status,handler,notes,created_by,created_by_name,updated_by,updated_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...values,actor.id,actorName,actor.id,actorName]);
        id = String(result.insertId);
      }
      if (plan.mode !== 'none' || plan.removeIds.length) await applyAttachmentPlan(connection, id, plan, actor);
      const [rows] = await connection.query(`${selectEntries} WHERE e.id=?`,[id]);
      saved = shapeEntryRow(rows[0]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    await writeAudit(req, updating ? 'cost.update' : 'cost.create', 'cost_entry', id, `${entry.project} / ${entry.category}`);
    res.status(updating ? 200 : 201).json({ok:true,entry:saved});
  }
  router.post('/', route((req,res) => save(req,res,false)));
  router.put('/:id', route((req,res) => save(req,res,true)));
  router.get('/:id/attachments', route(async (req,res) => {
    if (!validId(req.params.id)) throw fail('记录不存在。',404);
    const [rows] = await db.query('SELECT CAST(id AS CHAR) AS id, filename AS name, mime FROM cost_attachments WHERE entry_id=? ORDER BY id',[req.params.id]);
    res.json({ok:true, attachments: rows.map(row => ({ id: String(row.id), name: row.name, kind: kindOf(row.name, row.mime) }))});
  }));
  router.get('/attachments/:id', route(async (req,res) => {
    if (!validId(req.params.id)) throw fail('附件不存在。',404);
    const [rows] = await db.query('SELECT filename,mime,content FROM cost_attachments WHERE id=?',[req.params.id]);
    if (!rows.length) throw fail('附件不存在。',404);
    const file = rows[0];
    res.set({ 'Content-Type':file.mime, 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"sandbox; default-src 'none'", 'Content-Disposition':`attachment; filename="voucher"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g,'%27')}` });
    res.send(file.content);
  }));
  router.use((error, req, res, next) => {
    if (!error.status) return next(error);
    res.status(error.status).json({ok:false,message:error.message});
  });
  return router;
}
