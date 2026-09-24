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
