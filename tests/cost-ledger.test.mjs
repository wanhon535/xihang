import test from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '../backend/src/cost-ledger.js';
const valid = { date: '2026-09-23', project: '项目甲', category: '采购', description: '设备', amount: '0.10', paymentStatus: 'unpaid', handler: '张三', notes: '' };
test('money is parsed exactly to integer cents, never rounded', () => {
  assert.equal(ledger.parseAmount('0.10'), '10');
  assert.equal(ledger.parseAmount('999999999.99'), '99999999999');
  for (const v of ['0', '-1', '1.001', '1e2', 'NaN', '1000000000', '', null, 0.1]) assert.throws(() => ledger.parseAmount(v));
});
test('validates calendar dates, required fields, enums and limits', () => {
  assert.equal(ledger.validateEntry(valid).amountCents, '10');
  for (const patch of [{ date:'2026-02-30' },{date:'2025-02-29'},{ project:'' },{ category:'a'.repeat(121) },{paymentStatus:'other'},{handler:''}]) assert.throws(() => ledger.validateEntry({...valid,...patch}));
  assert.equal(ledger.validateEntry({...valid,date:'2024-02-29'}).date,'2024-02-29');
});
test('summary is exact beyond Number safe integers', () => {
  assert.deepEqual(ledger.summarize([{amountCents:'9007199254740991',date:'2026-09-01',paymentStatus:'unpaid'}, {amountCents:'10',date:'2026-08-01',paymentStatus:'paid'}], '2026-09'), {totalCents:'9007199254741001',monthCents:'9007199254740991',unpaidCents:'9007199254740991'});
});
test('attachment validates actual signature, size, filename and base64', () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture').toString('base64');
  assert.equal(ledger.validateAttachment({name:'凭证.pdf',data:pdf}).mime,'application/pdf');
  for (const p of [{name:'../x.pdf',data:pdf},{name:'x.html',data:pdf},{name:'x.pdf',data:'%%%invalid'},{name:'x.pdf',data:Buffer.from('<script>x</script>').toString('base64')},{name:'x.pdf',data:Buffer.alloc(3*1024*1024+1).toString('base64')}]) assert.throws(()=>ledger.validateAttachment(p));
});
test('一条记录可以带多张凭证：attachments 走追加、attachment 保留旧的整条替换语义', () => {
  const png = n => ({ name: `凭证-${n}.png`, data: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from(`x${n}`)]).toString('base64') });
  const append = ledger.attachmentPlan({ attachments: [png(1), png(2), png(3)] });
  assert.equal(append.mode, 'append');
  assert.equal(append.items.length, 3);
  assert.deepEqual(append.removeIds, []);
  const single = ledger.attachmentPlan({ attachment: png(9) });
  assert.equal(single.mode, 'replace');
  assert.equal(single.items.length, 1);
  assert.deepEqual(ledger.attachmentPlan({}).mode, 'none');
  // 只删不传
  const removal = ledger.attachmentPlan({ removeAttachmentIds: ['7', '8', '7'] });
  assert.equal(removal.mode, 'none');
  assert.deepEqual(removal.removeIds, ['7', '8'], '应去重');
  // 上限与非法输入
  assert.throws(() => ledger.attachmentPlan({ attachments: Array.from({length: ledger.MAX_ATTACHMENTS_PER_REQUEST + 1}, (_, i) => png(i)) }), e => e.status === 400);
  assert.throws(() => ledger.attachmentPlan({ attachments: 'not-an-array' }));
  assert.throws(() => ledger.attachmentPlan({ removeAttachmentIds: ['0'] }));
  assert.throws(() => ledger.attachmentPlan({ removeAttachmentIds: ['abc'] }));
});
test('列表行把多张凭证整形成 attachments 数组（并对旧数据兜底）', () => {
  const shaped = ledger.shapeEntryRow({ id: '1', attachmentId: null, attachmentName: null, attachmentCount: null, attachmentsJson: '[{"id":"12","name":"b.pdf","mime":"application/pdf"},{"id":"9","name":"a.png","mime":"image/png"}]' });
  assert.deepEqual(shaped.attachments, [{ id: '9', name: 'a.png', kind: 'image' }, { id: '12', name: 'b.pdf', kind: 'pdf' }], '应按 id 升序');
  assert.equal(shaped.attachmentId, '9', '首个凭证同时写进 attachmentId，兼容老前端');
  assert.equal(shaped.attachmentCount, 2);
  assert.equal(shaped.attachmentsJson, undefined, '中间字段不应外泄');
  // 老的单凭证行（没有 attachmentsJson）也要能整形出一张
  const legacy = ledger.shapeEntryRow({ id: '2', attachmentId: '31', attachmentName: '凭证.pdf', attachmentCount: '1' });
  assert.deepEqual(legacy.attachments, [{ id: '31', name: '凭证.pdf', kind: 'pdf' }]);
  const empty = ledger.shapeEntryRow({ id: '3', attachmentId: null, attachmentName: null, attachmentCount: '0', attachmentsJson: null });
  assert.deepEqual(empty.attachments, []);
  assert.equal(empty.attachmentCount, 0);
});
