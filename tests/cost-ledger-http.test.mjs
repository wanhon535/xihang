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
  const creates = sql.filter(q=>q.includes('CREATE TABLE IF NOT EXISTS'));
  assert.equal(creates.length,2);
  assert.match(creates[1], /KEY idx_cost_attachment_entry \(entry_id\)/, '一条记录多个凭证：不再有唯一索引');
  assert.ok(!creates[1].includes('UNIQUE KEY'), '唯一索引必须去掉，否则第二张凭证会被替换');
  assert.equal(sql.length,3, '外加一次「老库唯一索引」探测（迁移用）');
  assert.match(sql[2], /SHOW INDEX FROM cost_attachments/);
});

// 假 DB：支持多张凭证（cost_attachments 是数组），足以覆盖 router 的真实 SQL 形状。
const makeDb = () => {
  const state = { rows: [], audits: [], files: [], fileSeq: 0 };
  const attachmentsOf = entryId => state.files.filter(file => String(file.entryId) === String(entryId));
  const decorate = row => {
    const list = attachmentsOf(row.id);
    return {
      ...row,
      attachmentId: list.length ? list[0].id : null,
      attachmentName: list.length ? list[0].filename : null,
      attachmentCount: list.length,
      attachmentsJson: list.length ? JSON.stringify(list.map(file => ({ id: file.id, name: file.filename, mime: file.mime }))) : null
    };
  };
  const db = {
    state,
    async query(sql, p = []) {
      if (sql.startsWith('INSERT INTO cost_entries')) {
        state.rows.push({id:String(state.rows.length+1),date:p[0],project:p[1],category:p[2],description:p[3],amountCents:p[4],paymentStatus:p[5],handler:p[6],notes:p[7],createdBy:String(p[8]),createdByName:p[9],updatedBy:String(p[10]),updatedByName:p[11],version:1});
        return [{insertId:state.rows.length}];
      }
      if (sql.startsWith('UPDATE cost_entries')) {
        const row=state.rows.find(r=>r.id===p[10] && r.version===p[11]);
        if(!row) return [{affectedRows:0}];
        Object.assign(row,{project:p[1],updatedBy:String(p[8]),updatedByName:p[9],version:row.version+1}); return [{affectedRows:1}];
      }
      if (sql.startsWith('SELECT id FROM cost_attachments')) return [attachmentsOf(p[0]).map(file => ({ id: file.id }))];
      if (sql.startsWith('INSERT INTO cost_attachments')) {
        state.files.push({ id: String(++state.fileSeq), entryId: p[0], filename: p[1], mime: p[2], content: p[3] });
        return [{ insertId: state.fileSeq }];
      }
      if (sql.startsWith('UPDATE cost_attachments')) {
        const file = state.files.find(f => f.id === String(p[4]));
        if (file) Object.assign(file, { filename: p[0], mime: p[1], content: p[2] });
        return [{ affectedRows: file ? 1 : 0 }];
      }
      if (sql.startsWith('DELETE FROM cost_attachments')) {
        const target = String(p[0]);
        const ids = sql.includes('IN (') ? p.slice(1).map(String) : attachmentsOf(target).map(f => f.id);
        state.files = state.files.filter(f => !(String(f.entryId) === target && ids.includes(String(f.id))));
        return [{ affectedRows: ids.length }];
      }
      if (sql.startsWith('SELECT filename')) return [attachmentsOf(p[0]).map(f=>({filename:f.filename,mime:f.mime,content:f.content}))];
      if (sql.startsWith('SELECT CAST(id AS CHAR)')) return [attachmentsOf(p[0]).map(f=>({id:f.id,name:f.filename,mime:f.mime}))];
      if (sql.startsWith('SELECT id FROM')) return [state.rows.filter(r=>r.id===p[0])];
      if (sql.includes('FROM cost_entries e')) {
        const list = sql.includes('WHERE e.id=')?state.rows.filter(r=>r.id===p[0]):state.rows;
        return [list.map(decorate)];
      }
      throw Error('unexpected SQL: '+sql);
    },
    async getConnection(){return {...db,beginTransaction:async()=>{},commit:async()=>{state.commits++;},rollback:async()=>{state.rollbacks++;},release(){}};}
  };
  state.commits=0; state.rollbacks=0;
  return db;
};
const startServer = async (db) => {
  const app=express(); app.use(express.json({limit:'8mb'}));
  app.use((req,res,next)=>{ const who=req.get('x-user'); req.session={user:who?{id:who==='b'?2:1,nick:who==='member'?'admin':who,role:who==='member'?'member':'admin'}:null};next(); });
  app.use('/api/admin/costs',createCostRouter({db,requireLogin:(req,res,next)=>req.session.user?next():res.status(401).json({ok:false}),requireAdmin:(req,res,next)=>next(),writeAudit:async(...args)=>db.state.audits.push(args.slice(1))}));
  app.use((err,req,res,next)=>res.status(500).json({message:err.message}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/admin/costs`;
  return { base, close: ()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));} };
};
const call = (base,path='',user='a',method='GET',body)=>fetch(base+path,{method,headers:{...(user?{'x-user':user}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const pdfFile = label => ({name:`凭证-${label}.pdf`,data:Buffer.from(`%PDF-1.7\n${label}`).toString('base64')});
const pngFile = label => ({name:`凭证-${label}.png`,data:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from(label)]).toString('base64')});

test('HTTP authorization, shared writes, optimistic conflict, audit and protected vouchers', async t => {
  const db=makeDb(); const {state}=db;
  const {base,close}=await startServer(db);
  t.after(close);
  for(const path of ['','/attachments/1']) {
    assert.equal((await call(base,path,null)).status,401);
    assert.equal((await call(base,path,'member')).status,403);
  }
  assert.equal((await call(base,'','member','POST',valid)).status,403);
  assert.equal((await call(base,'','a','POST',{...valid,amount:'1.001'})).status,400);
  let res=await call(base,'','a','POST',{...valid,attachment:pdfFile('a')});
  assert.equal(res.status,201); assert.equal((await res.json()).entry.createdBy,'1');
  res=await call(base,'','b'); let body=await res.json(); assert.equal(body.entries.length,1); assert.equal(body.summary.totalCents,'1230'); assert.equal(res.headers.get('cache-control'),'no-store');
  res=await call(base,'/1','b','PUT',{...valid,project:'admin B edit',version:1}); assert.equal(res.status,200); body=await res.json(); assert.equal(body.entry.updatedBy,'2'); assert.equal(body.entry.version,2);
  assert.equal((await call(base,'/1','a','PUT',{...valid,version:1})).status,409);
  assert.equal((await call(base,'/99','a','PUT',{...valid,version:1})).status,404);
  res=await call(base,'/attachments/1','b'); assert.equal(res.status,200); assert.equal(res.headers.get('x-content-type-options'),'nosniff'); assert.match(res.headers.get('content-disposition'),/^attachment;/); assert.match(await res.text(),/^%PDF-/);
  assert.equal((await call(base,'/attachments/99')).status,404);
  assert.equal(state.commits,2); assert.equal(state.rollbacks,2); assert.deepEqual(state.audits.map(a=>a[0]),['cost.create','cost.update']);
});

test('一条记录可以挂多张凭证：多张不再互相替换，可追加也可单张删除', async t => {
  const db=makeDb(); const {state}=db;
  const {base,close}=await startServer(db);
  t.after(close);
  // 一次提交 3 张
  let res=await call(base,'','a','POST',{...valid,attachments:[pngFile('1'),pngFile('2'),pngFile('3')]});
  assert.equal(res.status,201);
  let entry=(await res.json()).entry;
  assert.equal(state.files.length,3,'三张都要落库，不能只留最后一张');
  assert.deepEqual(state.files.map(f=>f.filename),['凭证-1.png','凭证-2.png','凭证-3.png']);
  assert.equal(entry.attachmentCount,3);
  assert.equal(entry.attachments.length,3);
  assert.equal(entry.attachmentId,state.files[0].id,'首个凭证兼容字段');

  // 列表接口必须一条记录一行（多凭证不能把记录复制成多行）
  res=await call(base,'','a'); let body=await res.json();
  assert.equal(body.entries.length,1);
  assert.equal(body.entries[0].attachments.length,3);
  assert.equal(body.entries[0].attachments[1].kind,'image');
  assert.equal(body.entries[0].attachmentsJson,undefined,'中间字段不应外泄');

  // 追加第 4 张 + 删掉第 1 张
  const removeId=state.files[0].id;
  res=await call(base,'/1','a','PUT',{...valid,version:1,attachments:[pngFile('4')],removeAttachmentIds:[removeId]});
  assert.equal(res.status,200);
  entry=(await res.json()).entry;
  assert.deepEqual(state.files.map(f=>f.filename),['凭证-2.png','凭证-3.png','凭证-4.png']);
  assert.equal(entry.attachmentCount,3);
  assert.ok(!state.files.some(f=>f.id===removeId));

  // 单独删一张、不新增
  res=await call(base,'/1','a','PUT',{...valid,version:2,removeAttachmentIds:[state.files[0].id]});
  assert.equal(res.status,200);
  assert.equal((await res.json()).entry.attachmentCount,2);

  // 单凭证列表接口
  res=await call(base,'/1/attachments','a');
  const listed=await res.json();
  assert.equal(listed.attachments.length,2);
  assert.deepEqual(listed.attachments.map(a=>a.name),['凭证-3.png','凭证-4.png']);

  // 旧字段 attachment 仍是「整条记录的凭证被替换」；只剩一张时保持行 id 不变（外链不失效）
  await call(base,'/1','a','PUT',{...valid,version:3,removeAttachmentIds:[state.files[0].id]});
  const keepId=state.files.find(f=>String(f.entryId)==='1').id;
  res=await call(base,'/1','a','PUT',{...valid,version:4,attachment:pdfFile('legacy')});
  assert.equal(res.status,200);
  assert.equal(state.files.filter(f=>String(f.entryId)==='1').length,1);
  assert.equal(state.files.find(f=>String(f.entryId)==='1').id,keepId);
  assert.equal(state.files.find(f=>String(f.entryId)==='1').mime,'application/pdf');

  // 非法输入
  assert.equal((await call(base,'/1','a','PUT',{...valid,version:5,removeAttachmentIds:['abc']})).status,400);
  assert.equal((await call(base,'/1','a','PUT',{...valid,version:5,attachments:[{name:'x.html',data:pngFile('x').data}]})).status,400);
});
