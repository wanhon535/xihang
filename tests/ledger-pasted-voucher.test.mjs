// 端到端：前端「粘贴截图」生成的凭证 payload 必须能被后端原样接收并回读。
//
// 前端（frontend/src/pages/ledger.js）粘贴后会提交：
//   { name: `凭证-YYYYMMDD-HHMMSS.png`, data: <原始 PNG 字节的 base64> }
// 这里用与 tests/cost-ledger-http.test.mjs 相同的「假 DB + 真 HTTP router」方式，
// 不触碰任何真实数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCostRouter } from '../backend/src/cost-ledger.js';

const PNG_HEAD = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngBytes = () => Buffer.concat([PNG_HEAD, Buffer.from('pasted-screenshot-fixture')]);
// 后端只认「扩展名与内容一致」；构造一个名不符实的 payload 验证兜底。
const jpegBytes = () => Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from('not-really-png-magic')]);

const entry = { date: '2026-10-09', project: '服务器采购', category: '云服务器', amount: '1200.50', paymentStatus: 'unpaid', handler: '万釔宏', description: '粘贴截图测试', notes: '' };

const startHarness = async () => {
  const rows = [];
  const files = [];
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith('INSERT INTO cost_entries')) {
        rows.push({ id: '1', date: params[0], project: params[1], category: params[2], description: params[3], amountCents: params[4], paymentStatus: params[5], handler: params[6], notes: params[7], createdBy: String(params[8]), createdByName: params[9], updatedBy: String(params[10]), updatedByName: params[11], version: 1 });
        return [{ insertId: 1 }];
      }
      if (sql.startsWith('SELECT id FROM cost_attachments')) return [[]];
      if (sql.startsWith('INSERT INTO cost_attachments')) { files[0] = { id: '1', entryId: params[0], filename: params[1], mime: params[2], content: params[3] }; return [{}]; }
      if (sql.startsWith('SELECT filename')) return [params[0] === '1' ? files : []];
      if (sql.includes('FROM cost_entries e')) return [rows];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async getConnection() { return { ...db, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }; }
  };
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use((req, res, next) => { req.session = { user: { id: 1, nick: '管理员', role: 'admin' } }; next(); });
  app.use('/api/admin/costs', createCostRouter({ db, requireLogin: (req, res, next) => next(), requireAdmin: (req, res, next) => next(), writeAudit: async () => {} }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ ok: false, message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/costs`;
  return {
    files,
    post: body => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    getAttachment: id => fetch(`${base}/attachments/${id}`),
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }
  };
};

const stampName = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `凭证-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
};

test('粘贴截图生成的 PNG 凭证被接受，并以 image/png 原样回读', async t => {
  const harness = await startHarness();
  t.after(harness.close);

  const bytes = pngBytes();
  const name = stampName();
  const response = await harness.post({ ...entry, attachment: { name, data: bytes.toString('base64') } });
  assert.equal(response.status, 201, '中文文件名 + PNG 内容的粘贴凭证应被接受');
  assert.equal((await response.json()).entry.project, '服务器采购');

  assert.equal(harness.files[0].filename, name, '应原样保存前端生成的文件名');
  assert.equal(harness.files[0].mime, 'image/png', '应按魔数识别为 PNG');

  const download = await harness.getAttachment(1);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes, '回读字节应与粘贴内容完全一致');
});

test('名不符实的凭证（.png 后缀但 JPEG 内容）被后端拒绝', async t => {
  const harness = await startHarness();
  t.after(harness.close);

  const response = await harness.post({ ...entry, attachment: { name: stampName(), data: jpegBytes().toString('base64') } });
  assert.equal(response.status, 400, '前端校验被绕过时后端必须兜底');
  assert.match((await response.json()).message, /仅接受文件格式匹配的 PDF、PNG、JPEG 凭证/);
  assert.equal(harness.files.length, 0, '被拒绝的凭证不应落库');
});

test('超长文件名与非法 base64 均被拒绝', async t => {
  const harness = await startHarness();
  t.after(harness.close);

  const tooLong = await harness.post({ ...entry, attachment: { name: `${'凭'.repeat(200)}.png`, data: pngBytes().toString('base64') } });
  assert.equal(tooLong.status, 400);

  const badBase64 = await harness.post({ ...entry, attachment: { name: stampName(), data: 'not!!base64!!' } });
  assert.equal(badBase64.status, 400);
  assert.equal(harness.files.length, 0);
});
