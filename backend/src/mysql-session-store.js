import session from 'express-session';

export class MySqlSessionStore extends session.Store {
  constructor(poolProvider) {
    super();
    this.poolProvider = poolProvider;
  }

  get(sid, callback) {
    callback = callback || noop;
    this.poolProvider()
      .query('SELECT session_data AS sessionData FROM app_sessions WHERE sid = ? AND expires_at > NOW() LIMIT 1', [sid])
      .then(([rows]) => {
        if (!rows[0]) {
          callback(null, null);
          return;
        }

        callback(null, JSON.parse(rows[0].sessionData));
      })
      .catch((error) => callback(error));
  }

  set(sid, sessionData, callback) {
    callback = callback || noop;
    const expiresAt = toMysqlDate(resolveExpiresAt(sessionData));
    const payload = JSON.stringify(sessionData);

    this.poolProvider()
      .query(
        `INSERT INTO app_sessions (sid, session_data, expires_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           session_data = VALUES(session_data),
           expires_at = VALUES(expires_at)`,
        [sid, payload, expiresAt]
      )
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  destroy(sid, callback) {
    callback = callback || noop;
    this.poolProvider()
      .query('DELETE FROM app_sessions WHERE sid = ?', [sid])
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  touch(sid, sessionData, callback) {
    callback = callback || noop;
    const expiresAt = toMysqlDate(resolveExpiresAt(sessionData));

    this.poolProvider()
      .query('UPDATE app_sessions SET expires_at = ? WHERE sid = ?', [expiresAt, sid])
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  clearExpired() {
    return this.poolProvider().query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
  }
}

function resolveExpiresAt(sessionData) {
  const cookieExpires = sessionData?.cookie?.expires ? new Date(sessionData.cookie.expires) : null;
  if (cookieExpires && !Number.isNaN(cookieExpires.getTime())) {
    return cookieExpires;
  }

  const maxAge = Number(sessionData?.cookie?.maxAge || 0);
  return new Date(Date.now() + (maxAge > 0 ? maxAge : 1000 * 60 * 60 * 8));
}

function noop() {}

function toMysqlDate(value) {
  const pad = (number) => String(number).padStart(2, '0');
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate())
  ].join('-') + ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
