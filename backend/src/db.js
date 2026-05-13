import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const seedFile = path.join(rootDir, 'data', 'sites.json');

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'tidesail',
      waitForConnections: true,
      connectionLimit: 10,
      namedPlaceholders: true,
      charset: 'utf8mb4'
    });
  }

  return pool;
}

export async function initDatabase() {
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    charset: 'utf8mb4'
  });

  const database = process.env.MYSQL_DATABASE || 'tidesail';
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await connection.end();

  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(120) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      nick VARCHAR(160) NOT NULL DEFAULT '',
      unionid VARCHAR(128) NULL,
      openid VARCHAR(128) NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'member',
      last_login_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_users_username (username),
      UNIQUE KEY uk_users_unionid (unionid),
      KEY idx_users_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS nav_groups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS nav_sites (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      group_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      tags TEXT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_nav_sites_group_sort (group_id, sort_order),
      CONSTRAINT fk_nav_sites_group FOREIGN KEY (group_id) REFERENCES nav_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sso_tickets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      ticket CHAR(64) NOT NULL,
      target_url VARCHAR(1000) NOT NULL,
      user_nick VARCHAR(160) NOT NULL DEFAULT '',
      unionid VARCHAR(128) NOT NULL DEFAULT '',
      openid VARCHAR(128) NOT NULL DEFAULT '',
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_sso_tickets_ticket (ticket),
      KEY idx_sso_tickets_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM nav_groups');
  if (count === 0) {
    await seedFromJson();
  }

  await ensureLocalAdminUser();
}

export async function getSiteGroups() {
  const db = getPool();
  const [groups] = await db.query('SELECT id, name, description FROM nav_groups ORDER BY sort_order ASC, id ASC');
  const [sites] = await db.query(
    'SELECT id, group_id AS groupId, name, url, description, tags FROM nav_sites ORDER BY sort_order ASC, id ASC'
  );

  const byGroup = new Map();
  groups.forEach((group) => byGroup.set(group.id, { ...group, sites: [] }));
  sites.forEach((site) => {
    const group = byGroup.get(site.groupId);
    if (!group) {
      return;
    }

    group.sites.push({
      id: site.id,
      name: site.name,
      url: site.url,
      description: site.description,
      tags: parseTags(site.tags)
    });
  });

  return [...byGroup.values()];
}

export async function replaceSiteGroups(value) {
  const groups = normalizeSiteGroups(value);
  const db = getPool();
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM nav_sites');
    await connection.query('DELETE FROM nav_groups');

    for (const [groupIndex, group] of groups.entries()) {
      const [result] = await connection.query(
        'INSERT INTO nav_groups (name, description, sort_order) VALUES (?, ?, ?)',
        [group.name, group.description, groupIndex]
      );

      for (const [siteIndex, site] of group.sites.entries()) {
        await connection.query(
          'INSERT INTO nav_sites (group_id, name, url, description, tags, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
          [result.insertId, site.name, site.url, site.description, JSON.stringify(site.tags), siteIndex]
        );
      }
    }

    await connection.commit();
    return getSiteGroups();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createSsoTicket({ ticket, targetUrl, user, expiresAt }) {
  const db = getPool();
  await db.query(
    'INSERT INTO sso_tickets (ticket, target_url, user_nick, unionid, openid, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [ticket, targetUrl, user.nick || '', user.unionid || '', user.openid || '', toMysqlDate(expiresAt)]
  );
}

export async function consumeSsoTicket(ticket) {
  const db = getPool();
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const [rows] = await connection.query('SELECT * FROM sso_tickets WHERE ticket = ? FOR UPDATE', [ticket]);
    const record = rows[0];

    if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= Date.now()) {
      await connection.rollback();
      return null;
    }

    await connection.query('UPDATE sso_tickets SET consumed_at = NOW() WHERE id = ?', [record.id]);
    await connection.commit();

    return {
      targetUrl: record.target_url,
      user: {
        nick: record.user_nick,
        unionid: record.unionid,
        openid: record.openid
      },
      expiresAt: record.expires_at
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function cleanExpiredSsoTickets() {
  const db = getPool();
  await db.query('DELETE FROM sso_tickets WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY) OR consumed_at IS NOT NULL');
}

export async function ensureLocalAdminUser() {
  const username = process.env.LOCAL_ADMIN_USERNAME || 'admin';
  const password = process.env.LOCAL_ADMIN_PASSWORD || 'admin123456';
  const passwordHash = await bcrypt.hash(password, 10);
  const db = getPool();

  await db.query(
    `INSERT INTO users (username, password_hash, nick, role)
     VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), nick = VALUES(nick), role = 'admin'`,
    [username, passwordHash, username]
  );
}

export async function findUserByUsername(username) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]);
  return rows[0] || null;
}

export async function touchUserLogin(userId) {
  const db = getPool();
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
}

export async function upsertDingTalkUser(user, role = 'member') {
  const username = createUsername(user);
  const password = createRandomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const db = getPool();

  await db.query(
    `INSERT INTO users (username, password_hash, nick, unionid, openid, role, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       nick = VALUES(nick),
       openid = VALUES(openid),
       role = IF(role = 'admin', 'admin', VALUES(role)),
       last_login_at = NOW()`,
    [username, passwordHash, user.nick || username, user.unionid || null, user.openid || null, role]
  );

  const stored = user.unionid ? await findUserByUnionId(user.unionid) : await findUserByUsername(username);
  return { user: stored, generatedPassword: password };
}

export async function findUserByUnionId(unionid) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE unionid = ? LIMIT 1', [unionid]);
  return rows[0] || null;
}

async function seedFromJson() {
  try {
    const content = await fs.readFile(seedFile, 'utf8');
    await replaceSiteGroups(JSON.parse(content));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function normalizeSiteGroups(value) {
  if (!Array.isArray(value)) {
    throw new Error('导航配置必须是数组。');
  }

  return value
    .map((group) => ({
      name: String(group.name || '').trim(),
      description: String(group.description || '').trim(),
      sites: Array.isArray(group.sites)
        ? group.sites
            .map((site) => ({
              name: String(site.name || '').trim(),
              url: String(site.url || '').trim(),
              description: String(site.description || '').trim(),
              tags: Array.isArray(site.tags)
                ? site.tags.map((tag) => String(tag).trim()).filter(Boolean)
                : String(site.tags || '')
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean)
            }))
            .filter((site) => site.name && site.url)
        : []
    }))
    .filter((group) => group.name);
}

function parseTags(value) {
  if (!value) {
    return [];
  }

  try {
    const tags = JSON.parse(value);
    return Array.isArray(tags) ? tags : [];
  } catch {
    return String(value)
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
}

function toMysqlDate(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

function createUsername(user) {
  if (user.unionid) {
    return `ding_${user.unionid}`.slice(0, 120);
  }

  return String(user.nick || user.openid || 'dingtalk_user').trim().slice(0, 120);
}

function createRandomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}
