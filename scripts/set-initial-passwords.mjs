#!/usr/bin/env node
/**
 * 批量重置用户初始密码（A 方案：工号派生规则）
 *
 * 规则：
 *   初始密码 = 用户名 + "@" + 后缀
 *   例：xigou001 → xigou001@Xh
 *
 * 特性：
 *   - 只处理「从来没用过密码」的账号（password_changed_at IS NULL），
 *     已经自己改过密码的人绝对不会被覆盖。
 *   - 同时置 must_change_password = 1，员工首次登录会被强制改密码。
 *   - admin 默认跳过（可用 --include-admin 强制包含）。
 *
 * 用法：
 *   node scripts/set-initial-passwords.mjs --dry-run    # 预览
 *   node scripts/set-initial-passwords.mjs --apply      # 执行
 *   SUFFIX=YJ node scripts/... --apply                  # 换后缀
 *   ADMIN_PASSWORD='xxx' node scripts/... --apply       # 顺带给 admin 设密码
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
// 与后端 backend/src/db.js 使用同一个 bcryptjs，保证哈希互通
const { default: bcrypt } = await import(path.join(ROOT, 'node_modules/bcryptjs/index.js'));

const APPLY = process.argv.includes('--apply');
const INCLUDE_ADMIN = process.argv.includes('--include-admin');
const FORCE = process.argv.includes('--force');       // 连改过密码的人也重置
const SUFFIX = process.env.SUFFIX || 'Xh';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'tidesail'
});

const [users] = await conn.query(
  `SELECT id, username, nick, role, status, must_change_password, password_changed_at
     FROM users ORDER BY username ASC`
);

const plan = [];
for (const u of users) {
  const isAdmin = u.username === 'admin';

  if (isAdmin) {
    if (ADMIN_PASSWORD) {
      plan.push({ ...u, action: 'set', password: ADMIN_PASSWORD, why: 'admin（--ADMIN_PASSWORD 指定）' });
    } else {
      plan.push({ ...u, action: 'skip', why: 'admin 保留，未提供 ADMIN_PASSWORD' });
    }
    continue;
  }

  if (u.password_changed_at && !FORCE) {
    plan.push({ ...u, action: 'skip', why: `本人已改过密码（${u.password_changed_at}）` });
    continue;
  }

  plan.push({ ...u, action: 'set', password: `${u.username}@${SUFFIX}`, why: u.password_changed_at ? '--force 覆盖' : '从未用过密码' });
}

console.log(`\n${APPLY ? '🔥 执行模式' : '🔍 预览模式'}   后缀=${SUFFIX}   强制首改=开\n`);
console.log('ID'.padEnd(6) + '工号'.padEnd(14) + '昵称'.padEnd(13) + '初始密码'.padEnd(20) + '说明');
console.log('─'.repeat(92));
for (const p of plan) {
  const pw = p.action === 'set' ? p.password : '—';
  console.log(
    String(p.id).padEnd(6) +
    String(p.username).padEnd(14) +
    String(p.nick || '').slice(0, 11).padEnd(13) +
    String(pw).padEnd(20) +
    p.why
  );
}

const sets = plan.filter((p) => p.action === 'set');
console.log(`\n共 ${plan.length} 个账号：${sets.length} 个将设置初始密码，${plan.length - sets.length} 个跳过。`);

// 长度校验：低于系统最小长度会被登录策略拒绝，提前拦住
const tooShort = sets.filter((p) => p.password.length < 8);
if (tooShort.length) {
  console.error(`\n❌ 以下密码短于系统最小长度 8：${tooShort.map((p) => p.password).join(', ')}\n`);
  await conn.end();
  process.exit(1);
}

if (!APPLY) {
  console.log('\n确认无误后运行：node scripts/set-initial-passwords.mjs --apply\n');
  await conn.end();
  process.exit(0);
}

let done = 0;
for (const p of sets) {
  const hash = await bcrypt.hash(p.password, 10);
  // 设置初始密码 + 标记必须首改；password_changed_at 置 NULL 表示「这个密码是初始的」
  const [res] = await conn.query(
    'UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?',
    [hash, p.id]
  );
  if (res.affectedRows !== 1) {
    console.error(`❌ id=${p.id} 更新失败，已中止。`);
    await conn.end();
    process.exit(1);
  }
  done += 1;
}

console.log(`\n✅ 完成，已设置 ${done} 个账号的初始密码，并标记为「首次登录必须改密」。`);

const [after] = await conn.query(
  'SELECT id, username, nick, role, status, must_change_password, password_changed_at FROM users ORDER BY username ASC'
);
console.log('\n当前状态：');
console.log('ID'.padEnd(6) + '工号'.padEnd(14) + '昵称'.padEnd(13) + '状态'.padEnd(10) + '首改'.padEnd(6) + '改密时间');
console.log('─'.repeat(80));
for (const u of after) {
  console.log(
    String(u.id).padEnd(6) +
    String(u.username).padEnd(14) +
    String(u.nick || '').slice(0, 11).padEnd(13) +
    String(u.status).padEnd(10) +
    (u.must_change_password ? '是' : '否').padEnd(6) +
    (u.password_changed_at || '—')
  );
}
console.log('\n提示：请把初始密码单独告知本人，并提醒首次登录后立即修改。\n');

await conn.end();
