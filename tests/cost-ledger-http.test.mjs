import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { createCostRouter, validateEntry, validateAttachment, initCostLedger } from '../backend/src/cost-ledger.js';
const valid = {date:'2026-09-23',project:'shared',category:'设备',amount:'12.30',paymentStatus:'unpaid',handler:'甲'};

test('startup wiring mounts protected ledger and initializes schema', async () => {
  const server = await readFile(new URL('../backend/src/server.js', import.meta.url),'utf8');
  const db = await readFile(new URL('../backend/src/db.js', import.meta.url),'utf8');
  assert.match(server, /app\.use\('\/api\/admin\/costs', createCostRouter\(/);
  assert.match(db, /await initCostLedger\(db\)/);
});
test('null body is a validation error, and full-size valid attachment is accepted', () => {
  assert.throws(() => validateEntry(null), e => e.status === 400);
  const buffer = Buffer.alloc(3*1024*1024, 65); buffer.write('%PDF-1.7');
  assert.equal(validateAttachment({name:'full.pdf',data:buffer.toString('base64')}).buffer.length,buffer.length);
});
test('schema can be initialized without touching a real database', async () => {
  const sql=[]; await initCostLedger({query:async q=>sql.push(q)});
  assert.equal(sql.length,2); assert.ok(sql.every(q=>q.includes('CREATE TABLE IF NOT EXISTS')));
});
test('HTTP authorization (shared read/write, owner-only edits), optimistic conflict, audit and protected vouchers', async t => {
  const rows=[]; const audits=[]; const files={}; let commits=0, rollbacks=0;
  const db={async query(sql,p=[]) {
    if(sql.startsWith('INSERT INTO cost_entries')) {
      const id=String(rows.length+1);
      rows.push({id,date:p[0],project:p[1],category:p[2],description:p[3],amountCents:p[4],paymentStatus:p[5],handler:p[6],notes:p[7],createdBy:String(p[8]),createdByName:p[9],updatedBy:String(p[10]),updatedByName:p[11],version:1});
      return [{insertId:Number(id)}];
    }
    if(sql.startsWith('UPDATE cost_entries')) {
      const row=rows.find(r=>r.id===p[10] && r.version===p[11]);
      if(!row) return [{affectedRows:0}];
      Object.assign(row,{project:p[1],updatedBy:String(p[8]),updatedByName:p[9],version:row.version+1}); return [{affectedRows:1}];
    }
    if(sql.startsWith('INSERT INTO cost_attachments')) { files[p[0]]={filename:p[1],mime:p[2],content:p[3]}; return [{}]; }
    if(sql.startsWith('SELECT filename')) return [files[p[0]]?[files[p[0]]]:[]];
    if(sql.startsWith('SELECT created_by FROM')) return [rows.filter(r=>r.id===p[0]).map(r=>({created_by:r.createdBy}))];
    if(sql.startsWith('SELECT id FROM')) return [rows.filter(r=>r.id===p[0])];
    if(sql.includes('FROM cost_entries e')) return [sql.includes('WHERE e.id=')?rows.filter(r=>r.id===p[0]):rows];
    throw Error('unexpected SQL');
  },async getConnection(){return {...db,beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{rollbacks++;},release(){}};}};
  const app=express(); app.use(express.json({limit:'8mb'}));
  const identities={a:{id:1,nick:'a',role:'admin'},b:{id:2,nick:'b',role:'admin'},member:{id:3,nick:'member',role:'member'}};
  app.use((req,res,next)=>{ const who=req.get('x-user'); req.session={user:who?identities[who]:null};next(); });
  app.use('/api/admin/costs',createCostRouter({db,requireLogin:(req,res,next)=>req.session.user?next():res.status(401).json({ok:false}),writeAudit:async(...args)=>audits.push(args.slice(1))}));
  app.use((err,req,res,next)=>res.status(500).json({message:err.message}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}/api/admin/costs`;
  const call=(path='',user='a',method='GET',body)=>fetch(base+path,{method,headers:{...(user?{'x-user':user}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  // Unauthenticated is always 401; a plain member is now allowed onto the shared ledger.
  assert.equal((await call('',null)).status,401);
  assert.equal((await call('/attachments/1',null)).status,401);
  assert.equal((await call('','member')).status,200);
  assert.equal((await call('/attachments/1','member')).status,404); // nothing uploaded yet, not a permission error
  // Any logged-in account — not just admins — can record a new entry.
  let res=await call('','member','POST',valid);
  assert.equal(res.status,201); assert.equal((await res.json()).entry.createdBy,'3');
  assert.equal((await call('','a','POST',{...valid,amount:'1.001'})).status,400);
  res=await call('','a','POST',{...valid,attachment:{name:'凭证.pdf',data:Buffer.from('%PDF-1.7\nfixture').toString('base64')}});
  assert.equal(res.status,201); assert.equal((await res.json()).entry.createdBy,'1');
  res=await call('','b'); let body=await res.json(); assert.equal(body.entries.length,2); assert.equal(body.summary.totalCents,'2460'); assert.equal(res.headers.get('cache-control'),'no-store');
  // A member cannot edit an entry someone else created; an admin can edit anyone's.
  assert.equal((await call('/2','member','PUT',{...valid,project:'member edit',version:1})).status,403);
  res=await call('/2','b','PUT',{...valid,project:'admin B edit',version:1}); assert.equal(res.status,200); body=await res.json(); assert.equal(body.entry.updatedBy,'2'); assert.equal(body.entry.version,2);
  assert.equal((await call('/2','a','PUT',{...valid,version:1})).status,409);
  assert.equal((await call('/99','a','PUT',{...valid,version:1})).status,404);
  assert.equal((await call('/99','member','PUT',{...valid,version:1})).status,404);
  // Vouchers are shared reading too, not admin-only.
  res=await call('/attachments/2','member'); assert.equal(res.status,200); assert.equal(res.headers.get('x-content-type-options'),'nosniff'); assert.match(res.headers.get('content-disposition'),/^attachment;/); assert.match(await res.text(),/^%PDF-/);
  assert.equal((await call('/attachments/99')).status,404);
  assert.equal(commits,3); assert.equal(rollbacks,4); assert.deepEqual(audits.map(a=>a[0]),['cost.create','cost.create','cost.update']);
});
