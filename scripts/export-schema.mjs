// Read-only structure export. No account, credential, session or ledger rows are exported.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'node:fs/promises';
const tables = ['users','nav_groups','nav_sites','sso_tickets','personal_credentials','system_settings','admin_audit_logs','user_preferences','app_sessions','cost_entries','cost_attachments'];
const db = await mysql.createConnection({host:process.env.MYSQL_HOST || '127.0.0.1',port:Number(process.env.MYSQL_PORT || 3306),user:process.env.MYSQL_USER || 'root',password:process.env.MYSQL_PASSWORD || '',database:process.env.MYSQL_DATABASE || 'tidesail'});
try {
  let sql = '-- Xihang complete schema, exported from SHOW CREATE TABLE.\n-- Contains example navigation only. Local admin/settings are initialized on backend startup.\n-- Import into a NEW local database; CREATE IF NOT EXISTS is not an upgrade migration.\nSET NAMES utf8mb4;\nCREATE DATABASE IF NOT EXISTS `tidesail` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nUSE `tidesail`;\n\n';
  for (const table of tables) {
    const [[row]] = await db.query('SHOW CREATE TABLE ??', [table]);
    sql += row['Create Table'].replace(/^CREATE TABLE /,'CREATE TABLE IF NOT EXISTS ').replace(/ AUTO_INCREMENT=\d+/g,'') + ';\n\n';
  }
  const groups = JSON.parse(await fs.readFile(new URL('../data/sites.json',import.meta.url),'utf8'));
  sql += '-- Add example navigation only when there are no groups; preserve existing records.\nSET @seed_nav = (SELECT COUNT(*) = 0 FROM nav_groups);\n';
  for (const [i,group] of groups.entries()) {
    sql += mysql.format('INSERT INTO nav_groups (name, description, sort_order) SELECT ?, ?, ? WHERE @seed_nav = 1;\nSET @seed_group = LAST_INSERT_ID();\n',[group.name,group.description || '',i]);
    for (const [j,site] of (group.sites || []).entries()) sql += mysql.format('INSERT INTO nav_sites (group_id,name,url,description,tags,sort_order) SELECT @seed_group,?,?,?,?,? WHERE @seed_nav = 1;\n',[site.name,site.url,site.description || '',JSON.stringify(site.tags || []),j]);
  }
  await fs.writeFile(new URL('../sql/tidesail.sql',import.meta.url),sql);
  console.log(`Exported ${tables.length} table definitions and example navigation to sql/tidesail.sql`);
} finally { await db.end(); }
