# 汐航项目安全清理计划

生成日期：2026-05-24

本文件最初只给出清理建议和验证命令。当前项目已通过 `reorganize.ps1` 执行过一次安全清理和前端目录重组，备份目录为 `.backup_20260524_205007`。

当前已完成：

- 根目录临时截图 `.login-*.png`、`*ssofix*.png`、`*check*.png` 已删除并备份。
- `PROJECT_FRONTEND_PROMPT.md` 已删除并备份。
- `XIHANG_OPERATION_MANUAL.md` 已移动到 `docs/XIHANG_OPERATION_MANUAL.md`。
- 前端样式已移动到 `frontend/src/styles/styles.css`。
- 前端页面脚本已移动到 `frontend/src/pages/`。
- `README.md`、HTML 引用路径和测试脚本已同步。

回滚命令：

```powershell
.\reorganize.ps1 -Rollback ".backup_20260524_205007"
```

## 清理原则

- 优先通过 `reorganize.ps1` 操作，确保先备份再删除或移动。
- 不删除 `backend/`、`frontend/`、`sql/`、`scripts/`、`data/sites.json`、`.env.example`、`README.md`、`docs/XIHANG_OPERATION_MANUAL.md`。
- 不清理数据库、session、上传文件和任何业务数据。
- 不用 `git clean -fdx` 这类批量清理命令。
- 删除前先用 `rg` 检查引用，删除后跑 `npm.cmd run test:user-scenarios`。

## 已执行的扫描命令

```powershell
Get-ChildItem -Force
rg --files -g "*.png" -g "*.jpg" -g "*.jpeg" -g "*.webp" -g "*.gif"
rg --files -g "*.md"
rg --files -g "*.config.*" -g "*.conf.*" -g "*.rc" -g ".*rc" -g "vite.config.*" -g "vote.config.*"
```

## 已清理的临时截图

这些文件曾位于项目根目录，名称和时间都显示为登录、钉钉、SSO 调试截图。它们不参与构建和运行，已由 `reorganize.ps1` 删除并备份。

| 文件 | 建议 | 引用状态 | 引用检测命令 |
| --- | --- | --- | --- |
| `.login-current-style.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-current-style" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-check.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-check" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-eventlog2.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-eventlog2" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-live-check.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-live-check" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-ssofix-wait.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-ssofix-wait" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-ssofix.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-ssofix" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-dingtalk-ssofix3.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-dingtalk-ssofix3" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-live-check.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-live-check" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-self-check.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-self-check" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |
| `.login-ssofix.png` | 移动到 `docs/screenshots/` | 未发现引用 | `rg -n "login-ssofix" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |

如需回滚，使用脚本恢复备份；不建议再手动移动这些截图。历史手动移动命令保留如下，仅用于理解原计划：

```powershell
New-Item -ItemType Directory -Force docs\screenshots | Out-Null
Move-Item -LiteralPath .login-current-style.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-check.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-eventlog2.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-live-check.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-ssofix-wait.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-ssofix.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-dingtalk-ssofix3.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-live-check.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-self-check.png -Destination docs\screenshots\
Move-Item -LiteralPath .login-ssofix.png -Destination docs\screenshots\
```

确认截图不再需要后，再手动删除归档目录内文件：

```powershell
Remove-Item -LiteralPath docs\screenshots\.login-current-style.png
```

## 已清理的临时 Markdown

| 文件 | 建议 | 判断依据 | 引用检测命令 |
| --- | --- | --- | --- |
| `PROJECT_FRONTEND_PROMPT.md` | 已删除并备份 | 当前只有文件自身命中，未发现代码引用 | `rg -n "PROJECT_FRONTEND_PROMPT|汐航项目说明与前端提示词" . --glob "!node_modules/**" --glob "!.git/**" --glob "!dist/**"` |

手动移动命令：

```powershell
New-Item -ItemType Directory -Force docs\archive | Out-Null
Move-Item -LiteralPath PROJECT_FRONTEND_PROMPT.md -Destination docs\archive\PROJECT_FRONTEND_PROMPT.md
```

保留文件：

```text
README.md
docs/XIHANG_OPERATION_MANUAL.md
docs/CLEANUP_PLAN.md
docs/REFACTOR_STEPS.md
```

## 配置文件检查

| 文件 | 建议 | 判断依据 | 引用检测命令 |
| --- | --- | --- | --- |
| `vite.config.js` | 保留 | Vite 构建入口，`npm run build:frontend` 依赖它 | `rg -n "vite|vite.config|defineConfig" package.json README.md vite.config.js` |
| `vote.config.js` | 当前不存在 | 未在根目录发现该文件 | `Test-Path vote.config.js` |

`vite.config.js` 不应删除。它定义了 `frontend` 作为 Vite root，并配置了 `index/login/change-password/admin/vault` 多页面构建入口。

## 可选本地运行产物清理

这些文件通常不影响运行，且多数已经在 `.gitignore` 中。建议只在确认服务已经停止后再清理。

| 类型 | 示例 | 建议 |
| --- | --- | --- |
| 运行日志 | `.backend-dev.log`、`.backend-dev.err.log`、`.frontend-*.log` | 可删除，必要时保留最近一次排查日志 |
| 构建产物 | `dist/` | 可通过重新执行 `npm.cmd run build:frontend` 生成 |
| 依赖目录 | `node_modules/` | 不建议日常删除，必要时可删除后 `npm install` |
| 本地工具目录 | `.npm-cache/`、`.pm2/`、`.tools/`、`.screens/`、`.claude/` | 只在确认不再使用对应工具后清理 |
| 本地启动脚本 | `.local-*.cmd` | 如果仍用于手动启动，保留；否则归档到 `docs/archive/local-scripts/` |

日志清理示例：

```powershell
Remove-Item -LiteralPath .backend-dev.log
Remove-Item -LiteralPath .backend-dev.err.log
Remove-Item -LiteralPath .frontend-vite.log
Remove-Item -LiteralPath .frontend-vite.err.log
```

## 清理后的验证

移动或删除任何文件后，按顺序执行：

```powershell
npm.cmd run check
npm.cmd run build:frontend
npm.cmd run test:user-scenarios
node scripts\verify-after-refactor.mjs
```

如果前后端服务已经在 `2222/2223` 运行，也可以打开：

```text
http://127.0.0.1:2223/login.html
http://127.0.0.1:2223/
http://127.0.0.1:2223/admin.html
http://127.0.0.1:2223/vault.html
```

## 误删恢复方案

如果文件已经被 Git 跟踪：

```powershell
git restore -- README.md
git restore -- docs/XIHANG_OPERATION_MANUAL.md
git restore -- vite.config.js
```

如果文件是未跟踪的临时截图，Git 无法恢复。建议先移动到 `docs/screenshots/`，确认无用后再删除。

如果误删了 `dist/`：

```powershell
npm.cmd run build:frontend
```

如果误删了 `node_modules/`：

```powershell
npm install
```

如果误删了 `.env`，只能从备份或 `.env.example` 重新填写。`.env` 包含密钥和数据库密码，不能提交到 Git。
