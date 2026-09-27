import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { initCostLedger } from './cost-ledger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const seedFile = path.join(rootDir, 'data', 'sites.json');

let pool;

const DEFAULT_SYSTEM_SETTINGS = {
  productName: '汐航',
  companyName: '云南汐构信息技术有限公司',
  frontendUrl: 'http://127.0.0.1:2223',
  passwordMinLength: '8',
  sessionHours: '8',
  ssoTicketTtlSeconds: '120',
  requireDingTalk: 'false',
  smtpEnabled: 'false',
  smtpHost: '',
  smtpPort: '465',
  smtpFrom: '',
  backupRetentionDays: '30',
  smsProvider: 'aliyun',
  smsAccessKeyId: '',
  smsAccessKeySecret: '',
  smsSignName: '',
  smsTemplateCode: '',
  dingtalkNotifyAppKey: '',
  dingtalkNotifyAppSecret: '',
  dingtalkNotifyAgentId: '',
  dingtalkNotifyUserIds: '',
  dingtalkNotifyDeptIds: '',
  dingtalkRosterAppKey: '',
  dingtalkRosterAppSecret: '',
  dingtalkRosterCorpId: '',
  dingtalkWikiOperatorId: ''
};

const SYSTEM_SETTING_LABELS = {
  productName: '产品名称',
  companyName: '公司名称',
  frontendUrl: '前端地址',
  passwordMinLength: '最小密码长度',
  sessionHours: '会话有效小时数',
  ssoTicketTtlSeconds: 'SSO 票据有效秒数',
  requireDingTalk: '是否强制钉钉登录',
  smtpEnabled: '是否启用邮件服务',
  smtpHost: 'SMTP 主机',
  smtpPort: 'SMTP 端口',
  smtpFrom: '发件人',
  backupRetentionDays: '备份保留天数',
  smsProvider: '短信网关服务商',
  smsAccessKeyId: '短信 AccessKey ID',
  smsAccessKeySecret: '短信 AccessKey Secret',
  smsSignName: '短信签名',
  smsTemplateCode: '短信模板 Code',
  dingtalkNotifyAppKey: '监督agent钉钉应用 AppKey',
  dingtalkNotifyAppSecret: '监督agent钉钉应用 AppSecret',
  dingtalkNotifyAgentId: '监督agent钉钉 AgentId',
  dingtalkNotifyUserIds: '监督agent钉钉接收人 userid（逗号分隔）',
  dingtalkNotifyDeptIds: '监督agent钉钉接收部门 deptid（逗号分隔）',
  dingtalkRosterAppKey: '通讯录同步钉钉应用 AppKey',
  dingtalkRosterAppSecret: '通讯录同步钉钉应用 AppSecret',
  dingtalkRosterCorpId: '通讯录同步企业 CorpId',
  dingtalkWikiOperatorId: '知识库同步操作人 unionId'
};

// Settings that hold real external credentials, not configuration text: encrypted
// at rest with the same AES-256-GCM key the credential vault uses, never echoed
// back to the browser (listSystemSettings masks them), and only decryptable via
// getDecryptedSystemSetting() for server-side/script use.
const SECRET_SETTING_KEYS = new Set(['smsAccessKeySecret', 'dingtalkNotifyAppSecret', 'dingtalkRosterAppSecret']);
const SECRET_CONFIGURED_MARKER = '__configured__';

const DEFAULT_WORKSPACE_THEME = {
  mode: 'gradient',
  solidColor: '#08090a',
  gradientStart: '#08090a',
  gradientEnd: '#0f2f2b',
  gradientAngle: 135,
  imageUrl: '',
  overlay: 28
};

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
      dingtalk_userid VARCHAR(128) NULL,
      dingtalk_corp_id VARCHAR(128) NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'member',
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      must_change_password TINYINT(1) NOT NULL DEFAULT 0,
      password_changed_at DATETIME NULL,
      last_login_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_users_username (username),
      UNIQUE KEY uk_users_unionid (unionid),
      UNIQUE KEY uk_users_dingtalk_userid (dingtalk_corp_id, dingtalk_userid),
      KEY idx_users_role (role),
      KEY idx_users_status (status)
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
      icon_url VARCHAR(500) NOT NULL DEFAULT '',
      description VARCHAR(500) NOT NULL DEFAULT '',
      tags TEXT NULL,
      visibility VARCHAR(32) NOT NULL DEFAULT 'all',
      allowed_roles TEXT NULL,
      allowed_user_ids TEXT NULL,
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
      user_id BIGINT UNSIGNED NULL,
      username VARCHAR(160) NOT NULL DEFAULT '',
      user_nick VARCHAR(160) NOT NULL DEFAULT '',
      user_role VARCHAR(32) NOT NULL DEFAULT '',
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

  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(160) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      priority VARCHAR(8) NOT NULL DEFAULT 'P2',
      last_update DATE NULL,
      next_milestone VARCHAR(255) NOT NULL DEFAULT '',
      next_milestone_date DATE NULL,
      note TEXT NOT NULL,
      owner_phone VARCHAR(32) NOT NULL DEFAULT '',
      created_by BIGINT UNSIGNED NULL,
      updated_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_projects_name (name),
      KEY idx_projects_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS personal_credentials (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      title VARCHAR(180) NOT NULL,
      login_username VARCHAR(255) NOT NULL DEFAULT '',
      password_cipher TEXT NOT NULL,
      password_iv VARCHAR(64) NOT NULL,
      password_tag VARCHAR(64) NOT NULL,
      category VARCHAR(120) NOT NULL DEFAULT '默认',
      tags TEXT NULL,
      is_favorite TINYINT(1) NOT NULL DEFAULT 0,
      url VARCHAR(1000) NOT NULL DEFAULT '',
      notes TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_personal_credentials_user_favorite (user_id, is_favorite, updated_at),
      KEY idx_personal_credentials_user_updated (user_id, updated_at),
      CONSTRAINT fk_personal_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(80) NOT NULL,
      setting_value TEXT NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      updated_by BIGINT UNSIGNED NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key),
      KEY idx_system_settings_updated_by (updated_by),
      CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_user_id BIGINT UNSIGNED NULL,
      actor_name VARCHAR(160) NOT NULL DEFAULT '',
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(80) NOT NULL DEFAULT '',
      target_id VARCHAR(120) NOT NULL DEFAULT '',
      summary VARCHAR(600) NOT NULL DEFAULT '',
      ip VARCHAR(80) NOT NULL DEFAULT '',
      user_agent VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_audit_logs_created (created_at),
      KEY idx_admin_audit_logs_actor (actor_user_id),
      KEY idx_admin_audit_logs_action (action),
      CONSTRAINT fk_admin_audit_logs_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id BIGINT UNSIGNED NOT NULL,
      workspace_theme TEXT NULL,
      home_layout TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_user_preferences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      sid VARCHAR(128) NOT NULL,
      session_data MEDIUMTEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (sid),
      KEY idx_app_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dingtalk_docs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      workspace_id VARCHAR(120) NOT NULL,
      workspace_name VARCHAR(255) NOT NULL DEFAULT '',
      node_id VARCHAR(120) NOT NULL,
      name VARCHAR(500) NOT NULL DEFAULT '',
      url VARCHAR(1000) NOT NULL DEFAULT '',
      modified_time DATETIME NULL,
      synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_dingtalk_docs_node (workspace_id, node_id),
      KEY idx_dingtalk_docs_modified (modified_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await initCostLedger(db);
  await ensureUserColumns(db);
  await ensurePersonalCredentialColumns(db);
  await ensureNavSitePermissionColumns(db);
  await ensureUserPreferenceColumns(db);
  await ensureSsoTicketColumns(db);
  await ensureSystemSettings();

  const [[{ count }]] = await db.query('SELECT COUNT(*) AS count FROM nav_groups');
  if (count === 0) {
    await seedFromJson();
  }

  await ensureLocalAdminUser();
}

export async function getSiteGroups(options = {}) {
  const { user = null, includePermissions = false, hideEmptyGroups = false } = options || {};
  const db = getPool();
  const [groups] = await db.query('SELECT id, name, description FROM nav_groups ORDER BY sort_order ASC, id ASC');
  const [sites] = await db.query(
    `SELECT id, group_id AS groupId, name, url, icon_url AS iconUrl, description, tags, visibility,
       allowed_roles AS allowedRoles, allowed_user_ids AS allowedUserIds
     FROM nav_sites
     ORDER BY sort_order ASC, id ASC`
  );

  const byGroup = new Map();
  groups.forEach((group) => byGroup.set(group.id, { ...group, sites: [] }));
  sites.forEach((site) => {
    const group = byGroup.get(site.groupId);
    if (!group) {
      return;
    }

    if (user && !isSiteVisibleToUser(site, user)) {
      return;
    }

    group.sites.push(mapSite(site, includePermissions));
  });

  const result = [...byGroup.values()];
  return hideEmptyGroups ? result.filter((group) => group.sites.length > 0) : result;
}

export async function getSiteGroupsForUser(user) {
  return getSiteGroups({ user, hideEmptyGroups: true });
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
          `INSERT INTO nav_sites
             (group_id, name, url, icon_url, description, tags, visibility, allowed_roles, allowed_user_ids, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            result.insertId,
            site.name,
            site.url,
            site.iconUrl,
            site.description,
            JSON.stringify(site.tags),
            site.visibility,
            JSON.stringify(site.allowedRoles),
            JSON.stringify(site.allowedUserIds),
            siteIndex
          ]
        );
      }
    }

    await connection.commit();
    return getSiteGroups({ includePermissions: true });
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
    `INSERT INTO sso_tickets (ticket, target_url, user_id, username, user_nick, user_role, unionid, openid, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ticket, targetUrl, user.id, user.username || '', user.nick || '', user.role || '', user.unionid || '', user.openid || '', toMysqlDate(expiresAt)]
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
        id: record.user_id,
        username: record.username,
        nick: record.user_nick,
        role: record.user_role,
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

export async function listPersonalCredentials(userId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, title, login_username AS loginUsername, category, tags, is_favorite AS isFavorite,
       url, notes, created_at AS createdAt, updated_at AS updatedAt
     FROM personal_credentials
     WHERE user_id = ?
     ORDER BY is_favorite DESC, updated_at DESC, id DESC`,
    [userId]
  );

  return rows.map(mapPersonalCredential);
}

export async function createPersonalCredential(userId, value) {
  const credential = normalizePersonalCredential(value, { requirePassword: true });
  const encrypted = encryptVaultSecret(userId, credential.password);
  const db = getPool();

  const [result] = await db.query(
    `INSERT INTO personal_credentials
       (user_id, title, login_username, password_cipher, password_iv, password_tag, category, tags, is_favorite, url, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      credential.title,
      credential.loginUsername,
      encrypted.cipherText,
      encrypted.iv,
      encrypted.tag,
      credential.category,
      JSON.stringify(credential.tags),
      credential.isFavorite ? 1 : 0,
      credential.url,
      credential.notes
    ]
  );

  return findPersonalCredentialById(userId, result.insertId);
}

export async function updatePersonalCredential(userId, credentialId, value) {
  const credential = normalizePersonalCredential(value, { requirePassword: false });
  const fields = ['title = ?', 'login_username = ?', 'category = ?', 'tags = ?', 'is_favorite = ?', 'url = ?', 'notes = ?'];
  const params = [
    credential.title,
    credential.loginUsername,
    credential.category,
    JSON.stringify(credential.tags),
    credential.isFavorite ? 1 : 0,
    credential.url,
    credential.notes
  ];

  if (credential.hasPassword) {
    const encrypted = encryptVaultSecret(userId, credential.password);
    fields.push('password_cipher = ?', 'password_iv = ?', 'password_tag = ?');
    params.push(encrypted.cipherText, encrypted.iv, encrypted.tag);
  }

  params.push(credentialId, userId);

  const db = getPool();
  const [result] = await db.query(
    `UPDATE personal_credentials SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
    params
  );

  if (result.affectedRows === 0) {
    return null;
  }

  return findPersonalCredentialById(userId, credentialId);
}

export async function deletePersonalCredential(userId, credentialId) {
  const db = getPool();
  const [result] = await db.query('DELETE FROM personal_credentials WHERE id = ? AND user_id = ?', [
    credentialId,
    userId
  ]);

  return result.affectedRows > 0;
}

export async function getPersonalCredentialSecret(userId, credentialId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, title, password_cipher AS passwordCipher, password_iv AS passwordIv, password_tag AS passwordTag
     FROM personal_credentials
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [credentialId, userId]
  );
  const record = rows[0];

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    title: record.title,
    password: decryptVaultSecret(userId, record)
  };
}

export async function ensureLocalAdminUser() {
  const username = process.env.LOCAL_ADMIN_USERNAME || 'admin';
  const password = process.env.LOCAL_ADMIN_PASSWORD || 'admin123456';
  const passwordHash = await bcrypt.hash(password, 10);
  const db = getPool();

  await db.query(
    `INSERT INTO users (username, password_hash, nick, role, status, must_change_password)
     VALUES (?, ?, ?, 'admin', 'active', 0)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       nick = VALUES(nick),
       role = 'admin',
       status = 'active',
       must_change_password = 0`,
    [username, passwordHash, username]
  );
}

export async function listUsers() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT
       u.id, u.username, u.nick, u.unionid, u.openid, u.role, u.status,
       u.must_change_password AS mustChangePassword,
       u.password_changed_at AS passwordChangedAt,
       u.last_login_at AS lastLoginAt, u.created_at AS createdAt, u.updated_at AS updatedAt,
       COUNT(pc.id) AS vaultCount
     FROM users u
     LEFT JOIN personal_credentials pc ON pc.user_id = u.id
     GROUP BY u.id
     ORDER BY FIELD(u.role, 'admin', 'member') ASC, u.updated_at DESC, u.id DESC`
  );

  return rows.map(mapUser);
}

export async function createLocalUser(value) {
  const settings = await listSystemSettings();
  const user = normalizeLocalUser(value, {
    requirePassword: true,
    passwordMinLength: Number(settings.passwordMinLength || 8)
  });
  const passwordHash = await bcrypt.hash(user.password, 10);
  const db = getPool();

  try {
    const [result] = await db.query(
      `INSERT INTO users (username, password_hash, nick, role, status, must_change_password)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [user.username, passwordHash, user.nick, user.role, user.status]
    );

    return findUserById(result.insertId);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new Error('账号已存在。');
    }
    throw error;
  }
}

export async function updateUser(userId, value) {
  const user = normalizeUserUpdate(value);
  const db = getPool();
  const [result] = await db.query(
    `UPDATE users
     SET nick = ?, role = ?, status = ?
     WHERE id = ?`,
    [user.nick, user.role, user.status, userId]
  );

  if (result.affectedRows === 0) {
    return null;
  }

  return findUserById(userId);
}

export async function resetUserPassword(userId, password) {
  const settings = await listSystemSettings();
  const normalizedPassword = normalizePassword(password, Number(settings.passwordMinLength || 8));
  const passwordHash = await bcrypt.hash(normalizedPassword, 10);
  const db = getPool();
  const [result] = await db.query(
    'UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = NULL WHERE id = ?',
    [passwordHash, userId]
  );

  if (result.affectedRows === 0) {
    return null;
  }

  return findUserById(userId);
}

export async function deleteUser(userId) {
  const db = getPool();
  const [result] = await db.query('DELETE FROM users WHERE id = ?', [userId]);
  return result.affectedRows > 0;
}

const PROJECT_STATUSES = new Set(['active', 'paused', 'archived']);
const PROJECT_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function normalizeProjectDate(value, label) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  // Date.parse silently rolls invalid calendar dates forward (e.g. 2026-02-30
  // becomes 2026-03-02) instead of failing, so re-format the parsed date and
  // compare it back to the input to actually catch that case.
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(`${text}T00:00:00Z`)) ||
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`${label}格式不对，需要 YYYY-MM-DD。`);
  }
  return text;
}

function normalizeProjectInput(value) {
  if (!value || typeof value !== 'object') throw new Error('项目参数无效。');
  const name = String(value.name || '').trim();
  if (!name || name.length > 160) throw new Error('项目名称不能为空，且不超过 160 字。');
  const status = PROJECT_STATUSES.has(value.status) ? value.status : 'active';
  const priority = PROJECT_PRIORITIES.has(value.priority) ? value.priority : 'P2';
  const nextMilestone = String(value.nextMilestone || '').trim().slice(0, 255);
  const note = String(value.note || '').trim().slice(0, 2000);
  const ownerPhone = String(value.ownerPhone || '').trim().slice(0, 32);
  if (ownerPhone && !/^[\d+\-\s]{6,32}$/.test(ownerPhone)) throw new Error('负责人手机号格式不对。');
  return {
    name,
    status,
    priority,
    lastUpdate: normalizeProjectDate(value.lastUpdate, '最近更新日期'),
    nextMilestone,
    nextMilestoneDate: normalizeProjectDate(value.nextMilestoneDate, '下一个节点日期'),
    note,
    ownerPhone
  };
}

function mapProjectRow(row) {
  return {
    id: String(row.id),
    name: row.name,
    status: row.status,
    priority: row.priority,
    lastUpdate: row.lastUpdate,
    nextMilestone: row.nextMilestone,
    nextMilestoneDate: row.nextMilestoneDate,
    note: row.note,
    ownerPhone: row.ownerPhone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

const PROJECT_SELECT_SQL = `SELECT id, name, status, priority,
       DATE_FORMAT(last_update, '%Y-%m-%d') AS lastUpdate,
       next_milestone AS nextMilestone,
       DATE_FORMAT(next_milestone_date, '%Y-%m-%d') AS nextMilestoneDate,
       note, owner_phone AS ownerPhone, created_at AS createdAt, updated_at AS updatedAt
     FROM projects`;

async function findProjectById(db, projectId) {
  const [rows] = await db.query(`${PROJECT_SELECT_SQL} WHERE id=?`, [projectId]);
  return rows[0] ? mapProjectRow(rows[0]) : null;
}

// 管理中枢的“项目管理”面板、成本台账的项目下拉、数据大屏和汐构监督agent
// 共用这一份项目数据（取代早期手动维护的 data/xigou-projects.json）。
export async function listProjects() {
  const db = getPool();
  const [rows] = await db.query(
    `${PROJECT_SELECT_SQL} ORDER BY FIELD(status, 'active', 'paused', 'archived') ASC, updated_at DESC`
  );
  return rows.map(mapProjectRow);
}

export async function createProject(value, actorUserId = null) {
  const project = normalizeProjectInput(value);
  const db = getPool();
  try {
    const [result] = await db.query(
      `INSERT INTO projects (name, status, priority, last_update, next_milestone, next_milestone_date, note, owner_phone, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [project.name, project.status, project.priority, project.lastUpdate, project.nextMilestone, project.nextMilestoneDate, project.note, project.ownerPhone, actorUserId, actorUserId]
    );
    return await findProjectById(db, result.insertId);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new Error('已经有同名项目了。');
    throw error;
  }
}

export async function updateProject(projectId, value, actorUserId = null) {
  const project = normalizeProjectInput(value);
  const db = getPool();
  try {
    const [result] = await db.query(
      `UPDATE projects SET name=?, status=?, priority=?, last_update=?, next_milestone=?, next_milestone_date=?, note=?, owner_phone=?, updated_by=?
       WHERE id=?`,
      [project.name, project.status, project.priority, project.lastUpdate, project.nextMilestone, project.nextMilestoneDate, project.note, project.ownerPhone, actorUserId, projectId]
    );
    if (result.affectedRows === 0) return null;
    return await findProjectById(db, projectId);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw new Error('已经有同名项目了。');
    throw error;
  }
}

export async function deleteProject(projectId) {
  const db = getPool();
  const [result] = await db.query('DELETE FROM projects WHERE id = ?', [projectId]);
  return result.affectedRows > 0;
}

export async function getAdminOverview() {
  const db = getPool();
  const [[userStats]] = await db.query(`
    SELECT
      COUNT(*) AS totalUsers,
      SUM(status = 'active') AS activeUsers,
      SUM(status = 'disabled') AS disabledUsers,
      SUM(role = 'admin') AS adminUsers,
      SUM(role = 'member') AS memberUsers,
      SUM(last_login_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)) AS onlineUsers,
      SUM(DATE(created_at) = CURDATE()) AS newUsersToday
    FROM users
  `);
  const [[siteStats]] = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM nav_groups) AS groupCount,
      (SELECT COUNT(*) FROM nav_sites) AS siteCount,
      (SELECT COUNT(*) FROM personal_credentials) AS credentialCount,
      (SELECT COUNT(*) FROM sso_tickets WHERE consumed_at IS NULL AND expires_at > NOW()) AS activeSsoTickets
  `);
  const [[auditStats]] = await db.query(`
    SELECT COUNT(*) AS todayAuditLogs
    FROM admin_audit_logs
    WHERE DATE(created_at) = CURDATE()
  `);
  const settings = await listSystemSettings();

  return {
    totalUsers: Number(userStats.totalUsers || 0),
    activeUsers: Number(userStats.activeUsers || 0),
    disabledUsers: Number(userStats.disabledUsers || 0),
    adminUsers: Number(userStats.adminUsers || 0),
    memberUsers: Number(userStats.memberUsers || 0),
    onlineUsers: Number(userStats.onlineUsers || 0),
    newUsersToday: Number(userStats.newUsersToday || 0),
    groupCount: Number(siteStats.groupCount || 0),
    siteCount: Number(siteStats.siteCount || 0),
    credentialCount: Number(siteStats.credentialCount || 0),
    activeSsoTickets: Number(siteStats.activeSsoTickets || 0),
    todayAuditLogs: Number(auditStats.todayAuditLogs || 0),
    health: 100,
    settings
  };
}

const DEFAULT_HOME_LAYOUT = ['hero', 'stats', 'app-map'];
const HOME_LAYOUT_SECTIONS = new Set(DEFAULT_HOME_LAYOUT);

function normalizeHomeLayout(value) {
  const seen = new Set();
  const order = (Array.isArray(value) ? value : [])
    .filter((id) => typeof id === 'string' && HOME_LAYOUT_SECTIONS.has(id) && !seen.has(id) && seen.add(id));
  for (const id of DEFAULT_HOME_LAYOUT) if (!seen.has(id)) order.push(id);
  return order;
}

export async function getUserHomeLayout(userId) {
  const db = getPool();
  const [rows] = await db.query('SELECT home_layout AS homeLayout FROM user_preferences WHERE user_id = ? LIMIT 1', [userId]);
  if (!rows[0]?.homeLayout) return [...DEFAULT_HOME_LAYOUT];
  try {
    return normalizeHomeLayout(JSON.parse(rows[0].homeLayout));
  } catch {
    return [...DEFAULT_HOME_LAYOUT];
  }
}

export async function updateUserHomeLayout(userId, value) {
  const layout = normalizeHomeLayout(value);
  const db = getPool();
  await db.query(
    `INSERT INTO user_preferences (user_id, home_layout)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE home_layout = VALUES(home_layout)`,
    [userId, JSON.stringify(layout)]
  );
  return layout;
}

export async function getUserWorkspaceTheme(userId) {
  const db = getPool();
  const [rows] = await db.query('SELECT workspace_theme AS workspaceTheme FROM user_preferences WHERE user_id = ? LIMIT 1', [
    userId
  ]);

  if (!rows[0]?.workspaceTheme) {
    return { ...DEFAULT_WORKSPACE_THEME };
  }

  try {
    return normalizeWorkspaceTheme(JSON.parse(rows[0].workspaceTheme));
  } catch {
    return { ...DEFAULT_WORKSPACE_THEME };
  }
}

export async function updateUserWorkspaceTheme(userId, value) {
  const theme = normalizeWorkspaceTheme(value);
  const db = getPool();
  await db.query(
    `INSERT INTO user_preferences (user_id, workspace_theme)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE workspace_theme = VALUES(workspace_theme)`,
    [userId, JSON.stringify(theme)]
  );

  return theme;
}

export async function listSystemSettings() {
  const db = getPool();
  const [rows] = await db.query(
    'SELECT setting_key AS settingKey, setting_value AS settingValue FROM system_settings ORDER BY setting_key ASC'
  );
  const settings = { ...DEFAULT_SYSTEM_SETTINGS };

  rows.forEach((row) => {
    if (Object.prototype.hasOwnProperty.call(settings, row.settingKey)) {
      settings[row.settingKey] = row.settingValue ?? '';
    }
  });

  // Secret settings are encrypted at rest and never sent to the browser as
  // their real value; the UI only needs to know "is one already configured".
  for (const key of SECRET_SETTING_KEYS) {
    settings[key] = settings[key] ? SECRET_CONFIGURED_MARKER : '';
  }

  return settings;
}

export async function updateSystemSettings(value, actorUserId = null) {
  const settings = normalizeSystemSettings(value);
  const db = getPool();

  for (const [key, settingValue] of Object.entries(settings)) {
    if (SECRET_SETTING_KEYS.has(key)) {
      // Blank means "leave the stored secret alone" (the field is rendered as
      // a password input that's never pre-filled with the real value), so an
      // empty submit must not overwrite it. The UI's own "configured" marker
      // is never written back either, since it isn't a real secret value.
      if (!settingValue || settingValue === SECRET_CONFIGURED_MARKER) continue;
      await db.query(
        `INSERT INTO system_settings (setting_key, setting_value, description, updated_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value = VALUES(setting_value),
           description = VALUES(description),
           updated_by = VALUES(updated_by)`,
        [key, encryptSystemSecret(settingValue), SYSTEM_SETTING_LABELS[key] || '', actorUserId]
      );
      continue;
    }
    await db.query(
      `INSERT INTO system_settings (setting_key, setting_value, description, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value = VALUES(setting_value),
         description = VALUES(description),
         updated_by = VALUES(updated_by)`,
      [key, settingValue, SYSTEM_SETTING_LABELS[key] || '', actorUserId]
    );
  }

  return listSystemSettings();
}

// For server-side/script consumers (e.g. the 汐构监督agent script) that need
// the real secret value, never exposed through the admin HTTP API.
export async function getDecryptedSystemSetting(key) {
  if (!SECRET_SETTING_KEYS.has(key)) throw new Error(`${key} 不是加密配置项。`);
  const db = getPool();
  const [rows] = await db.query('SELECT setting_value AS settingValue FROM system_settings WHERE setting_key=?', [key]);
  if (!rows.length || !rows[0].settingValue) return '';
  return decryptSystemSecret(rows[0].settingValue);
}

const SYSTEM_SECRET_AAD = 'system-settings';

function encryptSystemSecret(value) {
  const { cipherText, iv, tag } = encryptAesGcm(SYSTEM_SECRET_AAD, value);
  return JSON.stringify({ c: cipherText, iv, tag });
}

function decryptSystemSecret(stored) {
  try {
    const { c, iv, tag } = JSON.parse(stored);
    return decryptAesGcm(SYSTEM_SECRET_AAD, { cipherText: c, iv, tag });
  } catch {
    throw new Error('配置项无法解密，请确认 VAULT_ENCRYPTION_KEY 未变更。');
  }
}

export async function listAuditLogs(limit = 80) {
  const db = getPool();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const [rows] = await db.query(
    `SELECT id, actor_user_id AS actorUserId, actor_name AS actorName, action, target_type AS targetType,
       target_id AS targetId, summary, ip, user_agent AS userAgent, created_at AS createdAt
     FROM admin_audit_logs
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [normalizedLimit]
  );

  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actorUserId,
    actorName: row.actorName || '',
    action: row.action || '',
    targetType: row.targetType || '',
    targetId: row.targetId || '',
    summary: row.summary || '',
    ip: row.ip || '',
    userAgent: row.userAgent || '',
    createdAt: row.createdAt
  }));
}

export async function recordAuditLog({ actor, action, targetType = '', targetId = '', summary = '', ip = '', userAgent = '' }) {
  const db = getPool();
  await db.query(
    `INSERT INTO admin_audit_logs
       (actor_user_id, actor_name, action, target_type, target_id, summary, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      actor?.id || null,
      String(actor?.nick || actor?.username || '').slice(0, 160),
      String(action || '').slice(0, 80),
      String(targetType || '').slice(0, 80),
      String(targetId || '').slice(0, 120),
      String(summary || '').slice(0, 600),
      String(ip || '').slice(0, 80),
      String(userAgent || '').slice(0, 500)
    ]
  );
}

export async function createAdminBackupSnapshot() {
  const [groups, users, settings, overview] = await Promise.all([
    getSiteGroups({ includePermissions: true }),
    listUsers(),
    listSystemSettings(),
    getAdminOverview()
  ]);

  return {
    product: settings.productName || '汐航',
    exportedAt: new Date().toISOString(),
    overview,
    settings,
    groups,
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      nick: user.nick,
      role: user.role,
      status: user.status,
      authType: user.authType,
      mustChangePassword: user.mustChangePassword,
      vaultCount: user.vaultCount,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }))
  };
}

export async function changeOwnPassword(userId, currentPassword, nextPassword) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  const user = rows[0];

  if (!user) {
    return null;
  }

  if (!(await bcrypt.compare(String(currentPassword || ''), user.password_hash))) {
    throw new Error('当前密码不正确。');
  }

  const settings = await listSystemSettings();
  const normalizedPassword = normalizePassword(nextPassword, Number(settings.passwordMinLength || 8));
  if (String(currentPassword || '') === normalizedPassword) {
    throw new Error('新密码不能和当前密码相同。');
  }

  const passwordHash = await bcrypt.hash(normalizedPassword, 10);
  await db.query(
    'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = NOW() WHERE id = ?',
    [passwordHash, userId]
  );

  return findUserById(userId);
}

export async function findUserById(userId) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  return rows[0] ? mapUser(rows[0]) : null;
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
  const dingTalkUserId = user.userid || user.userId || user.dingtalkUserId || '';
  const dingTalkCorpId = user.corpId || user.corp_id || '';

  await db.query(
    `INSERT INTO users
       (username, password_hash, nick, unionid, openid, dingtalk_userid, dingtalk_corp_id, role, status, must_change_password, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, NOW())
     ON DUPLICATE KEY UPDATE
       nick = VALUES(nick),
       unionid = COALESCE(VALUES(unionid), unionid),
       openid = COALESCE(VALUES(openid), openid),
       dingtalk_userid = COALESCE(VALUES(dingtalk_userid), dingtalk_userid),
       dingtalk_corp_id = COALESCE(VALUES(dingtalk_corp_id), dingtalk_corp_id),
       role = IF(role = 'admin', 'admin', VALUES(role)),
       status = IF(status = 'disabled', 'disabled', 'active'),
       last_login_at = NOW()`,
    [
      username,
      passwordHash,
      user.nick || username,
      user.unionid || null,
      user.openid || null,
      dingTalkUserId || null,
      dingTalkCorpId || null,
      role
    ]
  );

  const stored = user.unionid
    ? await findUserByUnionId(user.unionid)
    : dingTalkUserId && dingTalkCorpId
      ? await findUserByDingTalkUserId(dingTalkCorpId, dingTalkUserId)
      : await findUserByUsername(username);
  return { user: stored, generatedPassword: password };
}

export async function findUserByUnionId(unionid) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE unionid = ? LIMIT 1', [unionid]);
  return rows[0] || null;
}

export async function findUserByDingTalkUserId(corpId, userId) {
  const db = getPool();
  const [rows] = await db.query('SELECT * FROM users WHERE dingtalk_corp_id = ? AND dingtalk_userid = ? LIMIT 1', [
    corpId,
    userId
  ]);
  return rows[0] || null;
}

// Roster sync (只读同步): pre-creates/refreshes an account for every active
// DingTalk employee so an admin can assign role/site visibility before that
// person's first login, without ever touching last_login_at or reactivating
// an account an admin manually disabled. Unlike upsertDingTalkUser (the OAuth
// login path), this never counts as a "login" and never overrides role.
export async function upsertRosterUser({ dingtalkUserId, dingtalkCorpId, nick, unionid }) {
  const username = createUsername({ unionid, userid: dingtalkUserId });
  const password = createRandomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const db = getPool();

  await db.query(
    `INSERT INTO users
       (username, password_hash, nick, unionid, dingtalk_userid, dingtalk_corp_id, role, status, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, 'member', 'active', 0)
     ON DUPLICATE KEY UPDATE
       nick = VALUES(nick),
       unionid = COALESCE(VALUES(unionid), unionid),
       status = IF(status = 'disabled', 'disabled', 'active')`,
    [username, passwordHash, nick || username, unionid || null, dingtalkUserId, dingtalkCorpId]
  );
}

// Read-only knowledge-base list (只读列表+跳转): replaces the cached doc list
// with a fresh sync pull. We never store document content, only the pointers
// needed to show a list and jump back to DingTalk to actually read it.
export async function replaceDingTalkDocs(docs) {
  const db = getPool();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM dingtalk_docs');
    for (const doc of docs) {
      await connection.query(
        `INSERT INTO dingtalk_docs (workspace_id, workspace_name, node_id, name, url, modified_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [doc.workspaceId, doc.workspaceName || '', doc.nodeId, doc.name || '', doc.url || '', doc.modifiedTime || null]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listDingTalkDocs() {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT workspace_name AS workspaceName, node_id AS nodeId, name, url,
       modified_time AS modifiedTime, synced_at AS syncedAt
     FROM dingtalk_docs
     ORDER BY modified_time DESC, name ASC`
  );
  return rows;
}

// Marks accounts as disabled once their DingTalk userid stops appearing in a
// fresh roster pull (离职/移出通讯录) — only touches accounts this sync owns
// (dingtalk_corp_id matches, dingtalk_userid set), never local/manual accounts.
export async function disableStaleDingTalkUsers(corpId, activeUserIds) {
  const db = getPool();
  const ids = activeUserIds.filter(Boolean);
  const placeholders = ids.length ? ids.map(() => '?').join(',') : "''";
  const [result] = await db.query(
    `UPDATE users SET status = 'disabled'
     WHERE dingtalk_corp_id = ? AND dingtalk_userid IS NOT NULL AND status != 'disabled'
       AND dingtalk_userid NOT IN (${placeholders})`,
    [corpId, ...ids]
  );
  return result.affectedRows || 0;
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

async function ensureUserColumns(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const existingColumns = new Set(columns.map((column) => column.columnName));

  if (!existingColumns.has('status')) {
    await db.query("ALTER TABLE users ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active' AFTER role");
  }

  if (!existingColumns.has('must_change_password')) {
    await db.query('ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER status');
  }

  if (!existingColumns.has('password_changed_at')) {
    await db.query('ALTER TABLE users ADD COLUMN password_changed_at DATETIME NULL AFTER must_change_password');
  }

  if (!existingColumns.has('dingtalk_userid')) {
    await db.query('ALTER TABLE users ADD COLUMN dingtalk_userid VARCHAR(128) NULL AFTER openid');
  }

  if (!existingColumns.has('dingtalk_corp_id')) {
    await db.query('ALTER TABLE users ADD COLUMN dingtalk_corp_id VARCHAR(128) NULL AFTER dingtalk_userid');
  }

  const [indexes] = await db.query("SHOW INDEX FROM users WHERE Key_name = 'idx_users_status'");
  if (indexes.length === 0) {
    await db.query('ALTER TABLE users ADD INDEX idx_users_status (status)');
  }

  const [dingTalkIndexes] = await db.query("SHOW INDEX FROM users WHERE Key_name = 'uk_users_dingtalk_userid'");
  if (dingTalkIndexes.length === 0) {
    await db.query('ALTER TABLE users ADD UNIQUE KEY uk_users_dingtalk_userid (dingtalk_corp_id, dingtalk_userid)');
  }
}

async function ensurePersonalCredentialColumns(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'personal_credentials'`
  );
  const existingColumns = new Set(columns.map((column) => column.columnName));

  const columnSql = [
    ['category', "ALTER TABLE personal_credentials ADD COLUMN category VARCHAR(120) NOT NULL DEFAULT '默认' AFTER password_tag"],
    ['tags', 'ALTER TABLE personal_credentials ADD COLUMN tags TEXT NULL AFTER category'],
    ['is_favorite', 'ALTER TABLE personal_credentials ADD COLUMN is_favorite TINYINT(1) NOT NULL DEFAULT 0 AFTER tags']
  ];

  for (const [columnName, sql] of columnSql) {
    if (!existingColumns.has(columnName)) {
      await db.query(sql);
    }
  }

  const [indexes] = await db.query("SHOW INDEX FROM personal_credentials WHERE Key_name = 'idx_personal_credentials_user_favorite'");
  if (indexes.length === 0) {
    await db.query(
      'ALTER TABLE personal_credentials ADD INDEX idx_personal_credentials_user_favorite (user_id, is_favorite, updated_at)'
    );
  }
}

async function ensureSsoTicketColumns(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sso_tickets'`
  );
  const existingColumns = new Set(columns.map((column) => column.columnName));
  const columnSql = [
    ['user_id', 'ALTER TABLE sso_tickets ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER target_url'],
    ['username', "ALTER TABLE sso_tickets ADD COLUMN username VARCHAR(160) NOT NULL DEFAULT '' AFTER user_id"],
    ['user_role', "ALTER TABLE sso_tickets ADD COLUMN user_role VARCHAR(32) NOT NULL DEFAULT '' AFTER user_nick"]
  ];
  for (const [columnName, sql] of columnSql) {
    if (!existingColumns.has(columnName)) await db.query(sql);
  }
}

async function ensureUserPreferenceColumns(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_preferences'`
  );
  const existingColumns = new Set(columns.map((column) => column.columnName));
  if (!existingColumns.has('home_layout')) {
    await db.query('ALTER TABLE user_preferences ADD COLUMN home_layout TEXT NULL AFTER workspace_theme');
  }
}

async function ensureNavSitePermissionColumns(db) {
  const [columns] = await db.query(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nav_sites'`
  );
  const existingColumns = new Set(columns.map((column) => column.columnName));

  if (!existingColumns.has('icon_url')) {
    await db.query("ALTER TABLE nav_sites ADD COLUMN icon_url VARCHAR(500) NOT NULL DEFAULT '' AFTER url");
  }

  if (!existingColumns.has('visibility')) {
    await db.query("ALTER TABLE nav_sites ADD COLUMN visibility VARCHAR(32) NOT NULL DEFAULT 'all' AFTER tags");
  }

  if (!existingColumns.has('allowed_roles')) {
    await db.query('ALTER TABLE nav_sites ADD COLUMN allowed_roles TEXT NULL AFTER visibility');
  }

  if (!existingColumns.has('allowed_user_ids')) {
    await db.query('ALTER TABLE nav_sites ADD COLUMN allowed_user_ids TEXT NULL AFTER allowed_roles');
  }

  const [indexes] = await db.query("SHOW INDEX FROM nav_sites WHERE Key_name = 'idx_nav_sites_visibility'");
  if (indexes.length === 0) {
    await db.query('ALTER TABLE nav_sites ADD INDEX idx_nav_sites_visibility (visibility)');
  }
}

async function ensureSystemSettings() {
  const db = getPool();

  for (const [key, value] of Object.entries(DEFAULT_SYSTEM_SETTINGS)) {
    await db.query(
      `INSERT INTO system_settings (setting_key, setting_value, description)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_key = setting_key`,
      [key, value, SYSTEM_SETTING_LABELS[key] || '']
    );
  }
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username || '',
    nick: row.nick || row.username || '',
    unionid: row.unionid || '',
    openid: row.openid || '',
    dingtalkUserId: row.dingtalkUserId || row.dingtalk_userid || '',
    dingtalkCorpId: row.dingtalkCorpId || row.dingtalk_corp_id || '',
    role: normalizeRole(row.role),
    status: normalizeStatus(row.status),
    mustChangePassword: Boolean(row.mustChangePassword ?? row.must_change_password),
    passwordChangedAt: row.passwordChangedAt || row.password_changed_at || null,
    authType: row.unionid || row.dingtalk_userid ? 'dingtalk' : 'local',
    lastLoginAt: row.lastLoginAt || row.last_login_at || null,
    createdAt: row.createdAt || row.created_at || null,
    updatedAt: row.updatedAt || row.updated_at || null,
    vaultCount: Number(row.vaultCount || 0)
  };
}

function normalizeLocalUser(value, { requirePassword = false, passwordMinLength = 8 } = {}) {
  if (!value || typeof value !== 'object') {
    throw new Error('请求参数无效。');
  }

  const username = String(value.username || '').trim();
  if (!/^[A-Za-z0-9_.@-]{3,120}$/.test(username)) {
    throw new Error('账号只能包含字母、数字、下划线、点、@ 或短横线，长度至少 3 位。');
  }

  return {
    username,
    nick: String(value.nick || username).trim().slice(0, 160),
    password: requirePassword ? normalizePassword(value.password, passwordMinLength) : '',
    role: normalizeRole(value.role),
    status: normalizeStatus(value.status)
  };
}

function normalizeUserUpdate(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('请求参数无效。');
  }

  return {
    nick: String(value.nick || '').trim().slice(0, 160),
    role: normalizeRole(value.role),
    status: normalizeStatus(value.status)
  };
}

function normalizePassword(value, minLength = 8) {
  const password = String(value || '');
  const normalizedMinLength = clampInteger(minLength, 8, 64, 8);
  if (password.length < normalizedMinLength) {
    throw new Error(`密码至少需要 ${normalizedMinLength} 位。`);
  }
  if (password.length > 128) {
    throw new Error('密码不能超过 128 位。');
  }
  return password;
}

function normalizeRole(value) {
  return value === 'admin' ? 'admin' : 'member';
}

function normalizeStatus(value) {
  return value === 'disabled' ? 'disabled' : 'active';
}

function normalizeSystemSettings(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('配置参数无效。');
  }

  const settings = {};
  for (const key of Object.keys(DEFAULT_SYSTEM_SETTINGS)) {
    const rawValue = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : DEFAULT_SYSTEM_SETTINGS[key];
    settings[key] = normalizeSystemSettingValue(key, rawValue);
  }

  return settings;
}

function normalizeSystemSettingValue(key, value) {
  if (key === 'requireDingTalk' || key === 'smtpEnabled') {
    return String(Boolean(value === true || value === 'true'));
  }

  if (key === 'passwordMinLength') {
    return String(clampInteger(value, 8, 64, 8));
  }

  if (key === 'sessionHours') {
    return String(clampInteger(value, 1, 168, 8));
  }

  if (key === 'ssoTicketTtlSeconds') {
    return String(clampInteger(value, 30, 3600, 120));
  }

  if (key === 'smtpPort') {
    return String(clampInteger(value, 1, 65535, 465));
  }

  if (key === 'backupRetentionDays') {
    return String(clampInteger(value, 1, 365, 30));
  }

  if (key === 'frontendUrl') {
    const text = String(value || '').trim();
    if (text && !isHttpUrl(text)) {
      throw new Error('前端地址必须是 http 或 https 地址。');
    }
    return text.slice(0, 500);
  }

  return String(value || '').trim().slice(0, 500);
}

function normalizeWorkspaceTheme(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = ['solid', 'gradient', 'image'].includes(source.mode) ? source.mode : DEFAULT_WORKSPACE_THEME.mode;
  const imageUrl = normalizeWorkspaceImageUrl(source.imageUrl);

  return {
    mode: mode === 'image' && !imageUrl ? 'gradient' : mode,
    solidColor: normalizeHexColor(source.solidColor, DEFAULT_WORKSPACE_THEME.solidColor),
    gradientStart: normalizeHexColor(source.gradientStart, DEFAULT_WORKSPACE_THEME.gradientStart),
    gradientEnd: normalizeHexColor(source.gradientEnd, DEFAULT_WORKSPACE_THEME.gradientEnd),
    gradientAngle: clampInteger(source.gradientAngle, 0, 360, DEFAULT_WORKSPACE_THEME.gradientAngle),
    imageUrl,
    overlay: clampInteger(source.overlay, 0, 80, DEFAULT_WORKSPACE_THEME.overlay)
  };
}

function normalizeHexColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
}

function normalizeWorkspaceImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (
    !/^\/api\/user\/workspace-theme\/backgrounds\/[A-Za-z0-9_.-]+$/.test(text) &&
    !/^\/uploads\/workspace-backgrounds\/\d+\/[A-Za-z0-9_.-]+$/.test(text)
  ) {
    throw new Error('背景图片地址无效。');
  }

  return text.slice(0, 500);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(Math.max(number, min), max);
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
              iconUrl: String(site.iconUrl ?? site.icon_url ?? '').trim(),
              description: String(site.description || '').trim(),
              tags: Array.isArray(site.tags)
                ? site.tags.map((tag) => String(tag).trim()).filter(Boolean)
                : String(site.tags || '')
                    .split(/[,，]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean),
              visibility: normalizeSiteVisibility(site.visibility),
              allowedRoles: normalizeRoleList(site.allowedRoles ?? site.allowed_roles),
              allowedUserIds: normalizeUserIdList(site.allowedUserIds ?? site.allowed_user_ids)
            }))
            .filter((site) => site.name && site.url)
        : []
    }))
    .filter((group) => group.name);
}

function mapSite(site, includePermissions = false) {
  const mapped = {
    id: site.id,
    name: site.name,
    url: site.url,
    iconUrl: site.iconUrl || site.icon_url || '',
    description: site.description,
    tags: parseTags(site.tags)
  };

  if (includePermissions) {
    mapped.visibility = normalizeSiteVisibility(site.visibility);
    mapped.allowedRoles = normalizeRoleList(site.allowedRoles);
    mapped.allowedUserIds = normalizeUserIdList(site.allowedUserIds);
  }

  return mapped;
}

function isSiteVisibleToUser(site, user) {
  if (!user) {
    return false;
  }

  if (normalizeRole(user.role) === 'admin') {
    return true;
  }

  const visibility = normalizeSiteVisibility(site.visibility);
  if (visibility === 'all') {
    return true;
  }

  if (visibility === 'admins') {
    return false;
  }

  if (visibility === 'roles') {
    return normalizeRoleList(site.allowedRoles).includes(normalizeRole(user.role));
  }

  if (visibility === 'users') {
    return normalizeUserIdList(site.allowedUserIds).includes(Number(user.id));
  }

  return false;
}

function normalizeSiteVisibility(value) {
  const visibility = String(value || '').trim();
  return ['all', 'admins', 'roles', 'users'].includes(visibility) ? visibility : 'all';
}

function normalizeRoleList(value) {
  return [
    ...new Set(
      parseArrayLike(value)
        .map((item) => String(item || '').trim())
        .filter((item) => item === 'admin' || item === 'member')
    )
  ];
}

function normalizeUserIdList(value) {
  return [
    ...new Set(
      parseArrayLike(value)
        .map((item) => Number(item))
        .filter((item) => Number.isSafeInteger(item) && item > 0)
    )
  ];
}

function parseArrayLike(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === null || value === undefined || value === '') {
    return [];
  }

  if (typeof value === 'number') {
    return [value];
  }

  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to comma parsing for old or manually edited values.
  }

  return text
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
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

async function findPersonalCredentialById(userId, credentialId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT id, title, login_username AS loginUsername, category, tags, is_favorite AS isFavorite,
       url, notes, created_at AS createdAt, updated_at AS updatedAt
     FROM personal_credentials
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [credentialId, userId]
  );

  return rows[0] ? mapPersonalCredential(rows[0]) : null;
}

function mapPersonalCredential(row) {
  return {
    id: row.id,
    title: row.title,
    loginUsername: row.loginUsername || '',
    category: row.category || '默认',
    tags: parseTags(row.tags),
    isFavorite: Boolean(row.isFavorite),
    url: row.url || '',
    notes: row.notes || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizePersonalCredential(value, { requirePassword = false } = {}) {
  if (!value || typeof value !== 'object') {
    throw new Error('请求参数无效。');
  }

  const hasPassword = Object.prototype.hasOwnProperty.call(value, 'password');
  const credential = {
    title: String(value.title || '').trim(),
    loginUsername: String(value.loginUsername || '').trim(),
    password: hasPassword ? String(value.password || '') : '',
    hasPassword,
    category: String(value.category || '默认').trim() || '默认',
    tags: normalizeTags(value.tags),
    isFavorite: Boolean(value.isFavorite),
    url: String(value.url || '').trim(),
    notes: String(value.notes || '').trim()
  };

  if (!credential.title) {
    throw new Error('记录名称不能为空。');
  }

  if (credential.url && !isCredentialEndpoint(credential.url)) {
    throw new Error('网址或 IP 格式不正确。可填写 https://...、域名、IP:端口 或 localhost:端口。');
  }

  if (requirePassword && !credential.password) {
    throw new Error('密码不能为空。');
  }

  if (credential.hasPassword && !credential.password) {
    throw new Error('密码不能为空。');
  }

  return credential;
}

function normalizeTags(value) {
  const tags = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[,，]/);

  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isCredentialEndpoint(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 1000 || /\s/.test(text)) {
    return false;
  }

  if (/^https?:\/\//i.test(text)) {
    return isHttpUrl(text);
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) {
    return false;
  }

  const endpointPattern =
    /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(:\d{1,5})?(\/\S*)?$/i;
  return endpointPattern.test(text);
}

// Shared AES-256-GCM primitive: every encrypted-at-rest field in this app (vault
// credentials, automation-panel secrets) goes through this one implementation,
// keyed off getVaultKey() and scoped by an AAD the caller picks (user id for
// per-user vault records, a fixed string for global settings).
function encryptAesGcm(aad, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getVaultKey(), iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptAesGcm(aad, { cipherText, iv, tag }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getVaultKey(), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]).toString('utf8');
}

function encryptVaultSecret(userId, value) {
  return encryptAesGcm(userId, value);
}

function decryptVaultSecret(userId, record) {
  try {
    return decryptAesGcm(userId, { cipherText: record.passwordCipher, iv: record.passwordIv, tag: record.passwordTag });
  } catch {
    throw new Error('密码记录无法解密，请确认 VAULT_ENCRYPTION_KEY 与创建记录时一致。');
  }
}

function getVaultKey() {
  const secret = process.env.VAULT_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'dev-only-vault-key-change-me';
  return crypto.createHash('sha256').update(secret).digest();
}

function toMysqlDate(value) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(
    value.getMinutes()
  )}:${pad(value.getSeconds())}`;
}

function createUsername(user) {
  if (user.unionid) {
    return `ding_${user.unionid}`.slice(0, 120);
  }

  const dingTalkUserId = user.userid || user.userId || user.dingtalkUserId || '';
  if (dingTalkUserId) {
    const corpPart = String(user.corpId || user.corp_id || 'corp').replace(/[^a-zA-Z0-9_-]/g, '');
    return `ding_${corpPart}_${dingTalkUserId}`.slice(0, 120);
  }

  if (user.openid) {
    return `ding_${user.openid}`.slice(0, 120);
  }

  return String(user.nick || 'dingtalk_user').trim().slice(0, 120);
}

function createRandomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}
