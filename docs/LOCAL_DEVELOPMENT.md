# 本地开发启动

## 1. 环境与源码

安装 Node.js 20+、MySQL 8.x，启动本地 MySQL 服务。

```bash
git clone https://github.com/wanhon535/xihang.git
cd xihang
npm ci
```

已有源码执行 `git pull` 更新。

## 2. 本地配置

复制 `.env.example` 为 `.env`：

- macOS / Linux：`cp .env.example .env`
- Windows PowerShell：`Copy-Item .env.example .env`

至少填写：

```ini
PORT=2222
FRONTEND_ORIGIN=http://127.0.0.1:2223,http://localhost:2223
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=你的本地MySQL密码
MYSQL_DATABASE=tidesail
LOCAL_ADMIN_USERNAME=admin
LOCAL_ADMIN_PASSWORD=你设置的本地管理员密码
SESSION_SECRET=替换成一段随机字符串
VAULT_ENCRYPTION_KEY=替换成另一段固定的随机字符串
```

可运行 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成随机值。不要使用生产 `.env`；本地使用账号密码登录即可，钉钉配置可留空。数据库账号需要创建库、建表、修改表及读写权限。

## 3. 导入 SQL

在项目根目录执行（密码按提示输入）：

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p -e "source sql/tidesail.sql"
```

该命令适用于 PowerShell、CMD、bash；不依赖 PowerShell 不支持的 `<` 重定向。也可用数据库客户端打开 `sql/tidesail.sql` 执行。

SQL 默认创建并使用 `tidesail`，包含从当前线上库导出的完整 **11 张表结构**，包括 `cost_entries`、`cost_attachments`，以及示例导航数据。重复导入不会删除原记录，已有导航时不会重复添加示例入口。它不是旧库迁移脚本。

不需要导入线上账号、星钥、账目、会话、附件或任何线上密钥就能运行本地项目。初次启动后端会创建 `.env` 指定的管理员，补齐系统默认设置。示例站点使用 example.com，真实业务入口可在管理中枢自行配置。

后端也支持空库自动初始化：数据库账号权限足够时，可跳过手动导入，直接执行下一步。手动 SQL 供数据库客户端导入与查看完整结构使用。

## 4. 启动

```bash
npm run dev
```

打开 `http://127.0.0.1:2223/login.html`，使用 `.env` 中的本地管理员账号密码登录。

Vite 已将 `/api` 和 `/uploads` 转发至 `http://127.0.0.1:${PORT}`，默认后端端口 2222。修改 `.env` 端口后需要重启开发进程。

检查接口：`http://127.0.0.1:2223/api/health` 应返回 JSON。若是代理连接失败，检查后端启动日志与 MySQL 配置；若返回 Access denied，检查 MySQL 用户、密码和授权。

## 结构重新导出

```bash
node scripts/export-schema.mjs
```

该脚本只对 `.env` 指定的数据库执行 `SHOW CREATE TABLE`，不会修改数据库，也不会导出任何线上数据行。输出到 `sql/tidesail.sql`，示例导航取自仓库 `data/sites.json`。
