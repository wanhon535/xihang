#!/usr/bin/env node
/**
 * 一次性数据迁移：把已有用户的登录名改成工号（xigouNNN）。
 *
 * 规则：
 *   - 顺序按 created_at ASC, id ASC（即入职/首次注册时间先后）
 *   - admin 账号保留不动（它是本地账号，没有钉钉身份）
 *   - 只有带钉钉身份（dingtalk_userid 或 unionid）的账号才发工号
 *   - dingtalk_userid / unionid / openid 一律不动 → 钉钉扫码登录不受任何影响
 *
 * 用法：
 *   node scripts/migrate-work-numbers.mjs --dry-run   # 只预览
 *   node scripts/migrate-work-numbers.mjs --apply     # 真正执行
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 复用后端同一套 .env 加载方式
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const { default: mysql } = await import(path.join(ROOT, 'node_modules/mysql2/promise.js'));

const APPLY = process.argv.includes('--apply');
const PREFIX = process.env.WORK_NUMBER_PREFIX || 'xigou';
const PAD = Number(process.env.WORK_NUMBER_PAD || 3);

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'tidesail'
});

const [users] = await conn.query(
  `SELECT id, username, nick, role, status,
          unionid IS NOT NULL OR dingtalk_userid IS NOT NULL AS has_ding,
          created_at
     FROM users
    ORDER BY created_at ASC, id ASC`
);

const plan = [];
let seq = 0;
for (const u of users) {
  if (Number(u.has_ding) !== 1) {
    plan.push({ ...u, action: 'skip', reason: '无钉钉身份（本地账号），保留原名', target: u.username });
    continue;
  }
  seq += 1;
  const target = `${PREFIX}${String(seq).padStart(PAD, '0')}`;
  if (u.username === target) {
    plan.push({ ...u, action: 'noop', reason: '已是该工号', target });
  } else {
    plan.push({ ...u, action: 'rename', reason: '分配工号', target });
  }
}

console.log(`\n${APPLY ? '🔥 执行模式' : '🔍 预览模式（--dry-run）'}  前缀=${PREFIX}  数据库=${process.env.MYSQL_DATABASE || 'tidesail'}\n`);
console.log('ID'.padEnd(6) + '昵称'.padEnd(14) + '旧登录名'.padEnd(40) + '→  新工号'.padEnd(16) + '操作');
console.log('─'.repeat(100));
for (const p of plan) {
  const nick = String(p.nick || '').slice(0, 12).padEnd(14);
  const oldName = String(p.username).slice(0, 38).padEnd(40);
  const target = String(p.target).padEnd(16);
  console.log(`${String(p.id).padEnd(6)}${nick}${oldName}→  ${target}${p.action === 'rename' ? '✏️  改' : p.action === 'noop' ? '✓  已符合' : '·  跳过'}`);
}

const renames = plan.filter((p) => p.action === 'rename');
console.log(`\n共 ${plan.length} 个账号：${renames.length} 个待改名，${plan.length - renames.length} 个跳过/已符合。`);

if (!APPLY) {
  console.log('\n这只是预览。确认无误后运行：node scripts/migrate-work-numbers.mjs --apply\n');
  await conn.end();
  process.exit(0);
}

// 唯一性预检：目标工号之间、以及目标工号与未改名账号之间，都不能撞车
const targets = plan.filter((p) => p.action === 'rename').map((p) => p.target);
const duplicated = targets.filter((t, i) => targets.indexOf(t) !== i);
if (duplicated.length) {
  console.error(`\n❌ 目标工号内部重复：${[...new Set(duplicated)].join(', ')}，已中止。\n`);
  await conn.end();
  process.exit(1);
}

let changed = 0;
await conn.beginTransaction();
try {
  for (const p of renames) {
    const [res] = await conn.query('UPDATE users SET username = ? WHERE id = ?', [p.target, p.id]);
    if (res.affectedRows !== 1) throw new Error(`id=${p.id} 更新影响行数异常：${res.affectedRows}`);
    changed += 1;
  }
  await conn.commit();
  console.log(`\n✅ 迁移完成，已更新 ${changed} 个账号的登录名。`);
} catch (error) {
  await conn.rollback();
  console.error(`\n❌ 迁移失败并已回滚：${error.message}\n`);
  await conn.end();
  process.exit(1);
}

// 迁移后自检
const [after] = await conn.query(
  `SELECT id, username, nick, role, status,
          dingtalk_userid IS NOT NULL OR unionid IS NOT NULL AS has_ding
     FROM users ORDER BY username ASC`
);
console.log('\n迁移后全量账号：');
console.log('ID'.padEnd(6) + '登录名'.padEnd(16) + '昵称'.padEnd(14) + '角色'.padEnd(10) + '状态'.padEnd(10) + '钉钉身份');
console.log('─'.repeat(80));
for (const u of after) {
  console.log(
    String(u.id).padEnd(6) +
    String(u.username).padEnd(16) +
    String(u.nick || '').slice(0, 12).padEnd(14) +
    String(u.role).padEnd(10) +
    String(u.status).padEnd(10) +
    (Number(u.has_ding) === 1 ? '✓ 有（扫码登录正常）' : '—')
  );
}
console.log('');

await conn.end();
