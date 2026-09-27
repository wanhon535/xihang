// Explicitly opt-in; never starts production server or calls initDatabase().
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { getPool } from '../backend/src/db.js';
import { initCostLedger, createCostRouter } from '../backend/src/cost-ledger.js';

if (!process.argv.includes('--run')) {
  console.log('Opt-in required: node scripts/cost-ledger-mysql-isolated.mjs --run');
  process.exit(0);
}
// A URL .pathname keeps a leading slash before the drive letter on Windows
// (e.g. "/E:/..."), which dotenv's fs.readFileSync silently fails to find.
dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const pool = getPool();
const prefix = `cltest_${crypto.randomBytes(8).toString('hex')}_`;
const tables = ['cost_entries', 'cost_attachments'].map(n => prefix + n);
const stats = { commits: 0, rollbacks: 0, statements: 0 };
const passed = [];
let server, injectFailure = false, ownsNamespace = false;
const audits = [];
function rewrite(sql) {
  assert.ok(/\bcost_entries\b|\bcost_attachments\b/.test(sql), 'Only ledger SQL is permitted');
  const rewritten = sql.replace(/\b(cost_entries|cost_attachments|fk_cost_attachment_entry)\b/g, n => prefix + n);
  assert.ok(!/\b(cost_entries|cost_attachments)\b/.test(rewritten), 'Unprefixed ledger identifier');
  for (const match of rewritten.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE(?: IF NOT EXISTS)?)\s+([a-z_][a-z0-9_]*)/gi)) {
    // ON DUPLICATE KEY UPDATE is followed by a column, not a table.
    if (match[0].startsWith('UPDATE filename') || match[0] === 'UPDATE CURRENT_TIMESTAMP') continue;
    assert.ok(tables.includes(match[1]), 'SQL attempted to access a non-test table');
  }
  return rewritten;
}
function wrapQuery(target) {
  return async (sql, params = []) => {
    const safeSQL = rewrite(sql);
    if (injectFailure && sql.startsWith('INSERT INTO cost_attachments')) {
      injectFailure = false;
      params = [...params];
      params[4] = null; // Real MySQL NOT NULL violation AFTER parent insert/update.
    }
    stats.statements++;
    return target.query(safeSQL, params);
  };
}
const db = {
  query: wrapQuery(pool),
  async getConnection() {
    const connection = await pool.getConnection();
    return {
      query: wrapQuery(connection),
      beginTransaction: () => connection.beginTransaction(),
      async commit() { await connection.commit(); stats.commits++; },
      async rollback() { await connection.rollback(); stats.rollbacks++; },
      release: () => connection.release()
    };
  }
};
const step = name => { passed.push(name); console.log(`PASS ${name}`); };
try {
  const [[version]] = await pool.query('SELECT VERSION() AS version, @@sql_mode AS sqlMode');
  console.log(JSON.stringify({ mysql: version.version, sqlMode: version.sqlMode, prefix }));
  // No existing table is ever adopted or dropped.
  const [existing] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)', tables);
  assert.equal(existing.length, 0);
  ownsNamespace = true;
  await initCostLedger(db);
  await initCostLedger(db);
  const [schema] = await pool.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)', tables);
  assert.equal(schema.length, 2);
  assert.ok(schema.every(t => t.ENGINE === 'InnoDB' && t.TABLE_COLLATION === 'utf8mb4_unicode_ci'));
  step('original schema SQL and repeated initialization; InnoDB/utf8mb4');

  const app = express();
  app.use(express.json({ limit: '8mb' }));
  // Synthetic HTTP-only sessions; no users/sessions/audit business tables touched.
  app.use((req, res, next) => {
    const who = req.get('x-test-actor');
    req.session = { user: who ? { id: who === 'b' ? 2 : who === 'member' ? 3 : 1, nick: who, role: who === 'member' ? 'member' : 'admin' } : null };
    next();
  });
  app.use('/api/admin/costs', createCostRouter({
    db,
    requireLogin: (req, res, next) => req.session.user ? next() : res.status(401).json({ ok: false }),
    writeAudit: async (req, action, type, id) => audits.push({ action, type, id })
  }));
  app.use((err, req, res, next) => res.status(500).json({ ok: false, code: err.code || 'TEST_ERROR' }));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/admin/costs`;
  const call = (path = '', method = 'GET', body, actor = 'a') => fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(actor ? { 'x-test-actor': actor } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const input = { date: '2026-09-23', project: '隔离项目🚀', category: '设备', description: '真实数据库测试', amount: '999999999.99', paymentStatus: 'unpaid', handler: '测试经办人', notes: '不触碰业务数据' };
  const file = { name: '原始凭证.pdf', data: Buffer.from('%PDF-1.7\nisolated original').toString('base64') };
  assert.equal((await call('', 'GET', undefined, null)).status, 401);
  assert.equal((await call('/attachments/1', 'GET', undefined, null)).status, 401);
  assert.equal((await call('', 'GET', undefined, 'member')).status, 200); // shared ledger: any logged-in account can read
  assert.equal((await call('/attachments/1', 'GET', undefined, 'member')).status, 404); // nothing uploaded yet, not a permission error
  step('anonymous 401; a plain member is on the shared ledger, not blocked by role');
  for (const patch of [{ amount: '1.001' }, { amount: '0' }, { date: '2026-02-30' }, { attachment: { name: '../bad.pdf', data: file.data } }]) {
    assert.equal((await call('', 'POST', { ...input, ...patch })).status, 400);
  }
  assert.equal((await (await call()).json()).entries.length, 0);
  step('invalid amount/date/attachment rejected without writes');
  let response = await call('', 'POST', { ...input, attachment: file });
  assert.equal(response.status, 201);
  let row = (await response.json()).entry;
  const id = row.id, attachmentId = row.attachmentId;
  assert.equal(row.amountCents, '99999999999');
  assert.equal(row.project, input.project);
  assert.equal(row.date, input.date);
  assert.equal(row.createdBy, '1');
  assert.equal(row.version, 1);
  response = await call('', 'GET', undefined, 'b');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  let list = await response.json();
  assert.equal(list.entries.length, 1);
  assert.equal(list.summary.totalCents, '99999999999');
  assert.equal(list.summary.unpaidCents, '99999999999');
  step('create+read commit; exact maximum cents, DATE, Unicode, shared visibility and summary');
  response = await call(`/attachments/${attachmentId}`, 'GET', undefined, 'b');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(file.data, 'base64'));
  step('attachment bytes and secure download headers');
  assert.equal((await call(`/${id}`, 'PUT', { ...input, project: 'member cannot touch this', version: 1 }, 'member')).status, 403);
  step('a member cannot edit an entry created by someone else');

  const updatedFile = { name: '更新凭证.pdf', data: Buffer.from('%PDF-1.7\nisolated replacement').toString('base64') };
  const update = { ...input, amount: '0.01', paymentStatus: 'paid', project: '第二管理员更新', version: 1, attachment: updatedFile };
  response = await call(`/${id}`, 'PUT', update, 'b');
  assert.equal(response.status, 200);
  row = (await response.json()).entry;
  assert.equal(row.amountCents, '1');
  assert.equal(row.createdBy, '1');
  assert.equal(row.updatedBy, '2');
  assert.equal(row.version, 2);
  assert.equal(row.attachmentId, attachmentId);
  assert.equal(row.attachmentName, updatedFile.name);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM cost_attachments'))[0][0].n, 1);
  assert.deepEqual(Buffer.from(await (await call(`/attachments/${attachmentId}`)).arrayBuffer()), Buffer.from(updatedFile.data, 'base64'));
  step('update+attachment upsert commit; metadata/version and unique one-attachment invariant');
  assert.equal((await call(`/${id}`, 'PUT', update)).status, 409);
  assert.equal((await call('/999999', 'PUT', update)).status, 404);
  assert.equal((await call('/attachments/999999')).status, 404);
  step('stale version 409 and absent entry/attachment 404');

  const results = await Promise.all(['concurrent-a', 'concurrent-b'].map(project => call(`/${id}`, 'PUT', { ...input, project, version: 2 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  row = (await (await call()).json()).entries[0];
  assert.equal(row.version, 3);
  assert.equal(row.attachmentName, updatedFile.name);
  step('two simultaneous same-version updates: exactly one commit, one conflict; attachment retained');

  const before = JSON.stringify(row);
  const auditsBefore = audits.length;
  injectFailure = true;
  response = await call(`/${id}`, 'PUT', { ...input, project: 'MUST ROLLBACK', version: 3, attachment: file });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'ER_BAD_NULL_ERROR');
  assert.equal(JSON.stringify((await (await call()).json()).entries[0]), before);
  assert.deepEqual(Buffer.from(await (await call(`/attachments/${attachmentId}`)).arrayBuffer()), Buffer.from(updatedFile.data, 'base64'));
  injectFailure = true;
  response = await call('', 'POST', { ...input, attachment: file });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'ER_BAD_NULL_ERROR');
  assert.equal((await (await call()).json()).entries.length, 1);
  assert.equal(audits.length, auditsBefore);
  step('real MySQL attachment constraint failure rolls back both UPDATE and INSERT, no success audit');

  const large = Buffer.alloc(3 * 1024 * 1024, 65); large.write('%PDF-1.7');
  response = await call('', 'POST', { ...input, amount: '1.23', attachment: { name: 'large.pdf', data: large.toString('base64') } });
  assert.equal(response.status, 201);
  const largeEntry = (await response.json()).entry;
  assert.deepEqual(Buffer.from(await (await call(`/attachments/${largeEntry.attachmentId}`)).arrayBuffer()), large);
  step('3 MiB attachment HTTP/MySQL MEDIUMBLOB round trip');

  // There is deliberately no DELETE endpoint. Verify DB-level FK and transactional delete only.
  assert.equal((await call(`/${id}`, 'DELETE')).status, 404);
  await assert.rejects(db.query('DELETE FROM cost_entries WHERE id=?', [id]), e => e.code === 'ER_ROW_IS_REFERENCED_2');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM cost_attachments WHERE entry_id=?', [id]);
    await connection.query('DELETE FROM cost_entries WHERE id=?', [id]);
    await connection.rollback();
    assert.equal((await (await call()).json()).entries.length, 2);
    await connection.beginTransaction();
    await connection.query('DELETE FROM cost_attachments WHERE entry_id=?', [id]);
    await connection.query('DELETE FROM cost_entries WHERE id=?', [id]);
    await connection.commit();
    assert.equal((await (await call()).json()).entries.length, 1);
    assert.equal((await call(`/attachments/${attachmentId}`)).status, 404);
  } finally { connection.release(); }
  step('no API DELETE (404); FK restriction; DB-level delete rollback and commit');
  assert.deepEqual(audits.map(a => a.action), ['cost.create', 'cost.update', 'cost.update', 'cost.create']);
  assert.equal(stats.commits, 5);
  assert.equal(stats.rollbacks, 7);
  console.log(JSON.stringify({ passed: passed.length, ...stats, auditEvents: audits.length }));
} catch (error) {
  // Never log raw mysql errors: messages/SQL may include connection or business information.
  console.error(JSON.stringify({ failed: true, afterPassed: passed.length, name: error.name, code: error.code, assertion: error.operator, location: error.stack?.split('\n').find(line => line.includes('cost-ledger-mysql-isolated.mjs:'))?.trim() }));
  process.exitCode = 1;
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try {
    if (ownsNamespace) for (const table of [...tables].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${table}\``);
    const [remaining] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?)', tables);
    assert.equal(remaining.length, 0);
    console.log(JSON.stringify({ cleanup: 'PASS', remainingTestTables: remaining.length, prefix }));
  } catch (error) { console.error(JSON.stringify({ cleanup: 'FAILED', code: error.code, prefix })); process.exitCode = 1; }
  await pool.end();
}
