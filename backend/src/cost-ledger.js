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
    UNIQUE KEY uk_cost_attachment_entry (entry_id),
    CONSTRAINT fk_cost_attachment_entry FOREIGN KEY (entry_id) REFERENCES cost_entries(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}
const selectEntries = `SELECT CAST(e.id AS CHAR) AS id, DATE_FORMAT(e.cost_date, '%Y-%m-%d') AS date,
  e.project, e.category, e.description, CAST(e.amount_cents AS CHAR) AS amountCents,
  e.payment_status AS paymentStatus, e.handler, e.notes,
  CAST(e.created_by AS CHAR) AS createdBy, e.created_by_name AS createdByName,
  CAST(e.updated_by AS CHAR) AS updatedBy, e.updated_by_name AS updatedByName,
  e.version, e.created_at AS createdAt, e.updated_at AS updatedAt,
  CAST(a.id AS CHAR) AS attachmentId, a.filename AS attachmentName
  FROM cost_entries e LEFT JOIN cost_attachments a ON a.entry_id=e.id`;
const validId = (id) => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id);
export function createCostRouter({ db, requireLogin, requireAdmin, writeAudit = async () => {} }) {
  const router = express.Router();
  router.use(requireLogin, requireAdmin);
  // Existing admin middleware has legacy nickname allowlists. Ledger requires persisted admin role.
  router.use((req, res, next) => req.session.user.role === 'admin' ? next() : res.status(403).json({ok:false,message:'仅管理员可访问成本台账。'}));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/', route(async (req, res) => {
    const [entries] = await db.query(`${selectEntries} ORDER BY e.cost_date DESC, e.id DESC`);
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    res.json({ok:true, entries, summary:summarize(entries, month), month});
  }));
  async function save(req, res, updating) {
    const entry = validateEntry(req.body);
    if (updating && (!validId(req.params.id) || !Number.isSafeInteger(req.body.version) || req.body.version < 1)) throw fail('记录 ID 或版本无效。');
    const attachment = req.body.attachment == null ? null : validateAttachment(req.body.attachment);
    const actor = req.session.user;
    const actorName = String(actor.nick || actor.username || actor.id).slice(0,160);
    const connection = await db.getConnection();
    let id = req.params.id;
    let saved;
    try {
      await connection.beginTransaction();
      const values = [entry.date,entry.project,entry.category,entry.description,entry.amountCents,entry.paymentStatus,entry.handler,entry.notes];
      if (updating) {
        const [result] = await connection.query(`UPDATE cost_entries SET cost_date=?,project=?,category=?,description=?,amount_cents=?,payment_status=?,handler=?,notes=?,updated_by=?,updated_by_name=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND version=?`, [...values,actor.id,actorName,id,req.body.version]);
        if (!result.affectedRows) {
          const [found] = await connection.query('SELECT id FROM cost_entries WHERE id=?',[id]);
          throw fail(found.length ? '其他管理员已修改此记录，请刷新后重新编辑。' : '记录不存在。', found.length ? 409 : 404);
        }
      } else {
        const [result] = await connection.query(`INSERT INTO cost_entries (cost_date,project,category,description,amount_cents,payment_status,handler,notes,created_by,created_by_name,updated_by,updated_by_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...values,actor.id,actorName,actor.id,actorName]);
        id = String(result.insertId);
      }
      if (attachment) {
        await connection.query(`INSERT INTO cost_attachments (entry_id,filename,mime,content,uploaded_by) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE filename=VALUES(filename),mime=VALUES(mime),content=VALUES(content),uploaded_by=VALUES(uploaded_by),created_at=CURRENT_TIMESTAMP`, [id,attachment.name,attachment.mime,attachment.buffer,actor.id]);
      }
      const [rows] = await connection.query(`${selectEntries} WHERE e.id=?`,[id]);
      saved = rows[0];
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    await writeAudit(req, updating ? 'cost.update' : 'cost.create', 'cost_entry', id, `${entry.project} / ${entry.category}`);
    res.status(updating ? 200 : 201).json({ok:true,entry:saved});
  }
  router.post('/', route((req,res) => save(req,res,false)));
  router.put('/:id', route((req,res) => save(req,res,true)));
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
