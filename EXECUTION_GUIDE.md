# reorganize.ps1 执行说明

本项目当前在 Windows 环境下开发，因此生成的是 PowerShell 脚本：

```text
reorganize.ps1
```

脚本目标：

- 安全清理根目录临时截图和临时提示文档。
- 将 `XIHANG_OPERATION_MANUAL.md` 移入 `docs/`，并更新 `README.md` 链接。
- 创建后端规范目录：`backend/routes`、`backend/controllers`、`backend/middlewares`、`backend/utils`、`backend/config`。
- 创建前端规范目录：`frontend/src/styles`、`frontend/src/pages`。
- 移动现有前端 CSS 和页面 JS，并同步更新 HTML 引用路径。
- 如果 `frontend/src/api.js` 不存在，则生成基础模板；如果已存在，不覆盖。
- 每次删除、移动、覆盖、文本修改前都会备份并询问确认。
- 执行完成后自动运行 `npm.cmd run test:user-scenarios`；如果 npm 不可用，则尝试 `node scripts/verify-after-refactor.mjs`。

## 重要安全说明

脚本不会自动从 `backend/src/server.js` 中抽离 controller/service 函数。后端重构只做安全目录创建，以及移动已经独立存在的候选文件，例如 `auth.js`、`nav.js`、`authGuard.js`、`env.js` 等。

当前项目的后端逻辑主要仍在 `backend/src/server.js` 中，自动抽函数风险较高，应按 `docs/REFACTOR_STEPS.md` 手动分阶段处理。

## 执行前检查

先确认当前功能是好的：

```powershell
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
```

查看当前变更：

```powershell
git status --short
```

建议先建一个分支：

```powershell
git switch -c chore/reorganize-project
```

## 预演模式

只查看脚本会做什么，不写入任何文件：

```powershell
.\reorganize.ps1 -DryRun
```

## 交互执行

推荐方式。每个危险操作都会问你是否继续：

```powershell
.\reorganize.ps1
```

确认时输入：

```text
y
```

跳过时直接回车。

## 自动确认执行

确认你已经备份并理解风险后，可以自动确认所有操作：

```powershell
.\reorganize.ps1 -AssumeYes
```

如只想重组但暂时不跑测试：

```powershell
.\reorganize.ps1 -AssumeYes -SkipTests
```

## 备份位置

每次执行都会生成一个备份目录：

```text
.backup_yyyyMMdd_HHmmss/
```

备份目录里包含：

```text
files/         被删除、移动、覆盖、修改前的原文件
manifest.json 变更清单，用于回滚
```

不要手动修改 `.backup_*` 里的文件。

## 回滚

脚本执行结束后会输出回滚命令，例如：

```powershell
.\reorganize.ps1 -Rollback ".backup_20260524_210000"
```

更明确的写法：

```powershell
.\reorganize.ps1 -Rollback -BackupPath ".backup_20260524_210000"
```

也可以省略目录，自动使用最新的备份：

```powershell
.\reorganize.ps1 -Rollback
```

回滚会：

- 恢复被删除的文件。
- 把移动后的文件移回原位置。
- 恢复被修改的文件。
- 删除脚本新建的模板文件。
- 尝试删除脚本新建且为空的目录。

如果某个目录已经有新文件，回滚会保留该目录并提示。

## 执行后的验证

如果脚本没有跳过测试，会自动运行：

```powershell
npm.cmd run test:user-scenarios
```

你也可以手动再跑：

```powershell
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
node scripts\verify-after-refactor.mjs
```

浏览器手动检查：

```text
http://127.0.0.1:2223/login.html
http://127.0.0.1:2223/
http://127.0.0.1:2223/admin.html
http://127.0.0.1:2223/vault.html
```

## 脚本会清理什么

根目录中匹配以下模式的临时截图：

```text
*login*.png
*ssofix*.png
*check*.png
```

临时提示文件：

```text
PROJECT_FRONTEND_PROMPT.md
```

未知配置：

```text
vote.config.js
```

`vote.config.js` 删除前会先扫描 `.js`、`.mjs`、`.cjs`、`.json`、`.html`、`.css` 文件。如果发现 `vote.config` 字符串引用，会保留它。

## 脚本不会做什么

- 不删除 `README.md`。
- 不删除 `.env`。
- 不删除数据库、session 或上传文件。
- 不修改 MySQL 表结构。
- 不替换现有 SQL 为 ORM。
- 不修改 session 存储机制。
- 不自动拆分 `backend/src/server.js` 中的业务函数。
- 不覆盖已经存在的 `frontend/src/api.js`。

## 常见问题

PowerShell 禁止执行脚本时，可以只对当前窗口放开：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\reorganize.ps1
```

如果测试失败，先回滚：

```powershell
.\reorganize.ps1 -Rollback
```

然后检查失败日志，再按 `docs/REFACTOR_STEPS.md` 分阶段手动重构。
