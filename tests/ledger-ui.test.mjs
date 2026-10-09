import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
test('ledger frontend exists and uses safe rendering, role guard and conflict protection',()=>{
 assert.ok(existsSync('frontend/src/pages/ledger.js'));
 const js=readFileSync('frontend/src/pages/ledger.js','utf8');
 assert.ok(js.includes("user.role !== 'admin'"));
 assert.ok(js.includes('409'));
 assert.ok(js.includes('version'));
 assert.ok(!js.includes('innerHTML'));
 assert.ok(readFileSync('vite.config.js','utf8').includes('frontend/ledger.html'));
});
test('money helpers preserve cents beyond Number safe range',async()=>{
 assert.ok(existsSync('frontend/src/ledger-utils.js'));
 const {money,totalCents,filterEntries}=await import('../frontend/src/ledger-utils.js');
 assert.equal(money('9007199254740993'),'90071992547409.93');
 assert.equal(totalCents([{amountCents:'9007199254740993'},{amountCents:'7'}]),9007199254741000n);
 assert.deepEqual(filterEntries([{date:'2026-09-01',project:'甲',category:'采购',paymentStatus:'paid',description:'设备'}],{month:'2026-08'}),[]);
});
test('filterEntries 支持项目/类别多选（空数组 = 全部）',async()=>{
 const {filterEntries}=await import('../frontend/src/ledger-utils.js');
 const rows=[
  {date:'2026-05-01',project:'1060U',category:'跨境电商',paymentStatus:'paid',description:'',handler:'甲',notes:''},
  {date:'2026-05-02',project:'服务器',category:'采购',paymentStatus:'paid',description:'',handler:'乙',notes:''},
  {date:'2026-05-03',project:'表白墙推广',category:'运营',paymentStatus:'unpaid',description:'',handler:'丙',notes:''}
 ];
 const ids=x=>x.map(e=>e.project);
 // 不选 = 全部
 assert.deepEqual(ids(filterEntries(rows,{category:[],project:[]})),['1060U','服务器','表白墙推广']);
 // 单选
 assert.deepEqual(ids(filterEntries(rows,{category:['采购']})),['服务器']);
 // 多选
 assert.deepEqual(ids(filterEntries(rows,{category:['采购','运营']})),['服务器','表白墙推广']);
 // 两个维度叠加（AND）
 assert.deepEqual(ids(filterEntries(rows,{category:['跨境电商','采购'],project:['1060U']})),['1060U']);
 // 选了一个不存在的值 → 空
 assert.deepEqual(filterEntries(rows,{project:['不存在']}),[]);
 // 兼容旧的单个字符串写法
 assert.deepEqual(ids(filterEntries(rows,{category:'运营'})),['表白墙推广']);
 // 多选与其它条件叠加
 assert.deepEqual(ids(filterEntries(rows,{category:['采购','运营'],paymentStatus:'unpaid'})),['表白墙推广']);
});
