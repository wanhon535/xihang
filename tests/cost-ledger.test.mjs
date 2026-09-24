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
