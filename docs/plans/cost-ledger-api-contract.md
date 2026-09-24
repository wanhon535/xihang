# 成本台账后端接口 contract

## 接入与权限
- 基址：`/api/admin/costs`，沿用 `tidesail_sid` session cookie；fetch 使用 `credentials: 'include'`。
- server.js 已挂载 router；db.js 的 initDatabase 调用 initCostLedger，建表发生在未来服务启动时。本次没有启动生产代码、执行生产迁移或重启。
- 所有接口先执行现有 requireLogin（每次查数据库刷新用户、拒绝禁用账号/必须改密），再 requireAdmin，并额外强制 `session.user.role === 'admin'`，昵称 admin 的 member 仍被拒绝。
- 所有 admin 共享全部记录，不以 createdBy 分区；凭证不落公开目录，BLOB 只能通过受保护接口下载。

## 请求
### GET /api/admin/costs
返回 `200 {ok:true, entries:[Entry], summary:{totalCents,monthCents,unpaidCents}, month:'YYYY-MM'}`。
按日期倒序、ID 倒序；month 使用服务进程本地时区。无服务端筛选/分页；筛选、排序与分组由前端实现。summary 对全部记录汇总。

### POST /api/admin/costs
JSON：
```json
{"date":"2026-09-23","project":"项目甲","category":"采购","description":"设备","amount":"123.45","paymentStatus":"unpaid","handler":"张三","notes":"","attachment":{"name":"凭证.pdf","data":"原始Base64，不含data:前缀"}}
```
- `date`：真实日历日期 YYYY-MM-DD，1000-01-01 到 9999-12-31。
- `project/category/handler`：必填字符串，最大长度分别 160/120/160。
- `description/notes`：可省略，最大长度分别 1000/2000。
- `amount`：必须是十进制**字符串**，大于零、至多两位小数、最大 999999999.99；不接受数值类型、科学计数法、负数、前导零或空格。
- `paymentStatus`：`paid` / `unpaid`。
- `attachment`：可省略或 null；单条一个凭证，原始文件最大 3 MiB，仅 PDF/PNG/JPEG；文件扩展名须与签名匹配。
返回 `201 {ok:true,entry:Entry}`。

### PUT /api/admin/costs/:id
同 POST 完整业务字段，额外提供整数 `version`（读取记录的当前版本）。成功返回 `200 {ok:true,entry:Entry}`，version 自动增加。
- 未传 attachment 或 null：保留原凭证。
- 提供 attachment：原子替换原凭证。
- 禁止客户端指定审计身份；使用当前 session 用户写 createdBy/updatedBy。
- 并发版本不匹配 409；应提示刷新列表重新编辑，不能静默覆盖。

### GET /api/admin/costs/attachments/:attachmentId
返回原始二进制；强制 `Content-Disposition: attachment`、`nosniff`、sandbox CSP、`Cache-Control: no-store`。用 entries 中 attachmentId 构建 URL，不是 entry.id。

## Entry
`id,date,project,category,description,amountCents,paymentStatus,handler,notes,createdBy,createdByName,updatedBy,updatedByName,version,createdAt,updatedAt,attachmentId,attachmentName`。
- id、所有人员 ID、amountCents、summary 内所有分值均为**字符串**，version 是整数。
- attachmentId/attachmentName 无凭证时为 null。
- 金额展示请使用 BigInt/字符串拆分分，不要将汇总转浮点计算。
- createdAt/updatedAt 为数据库时间序列化值；数据库与进程时区沿用现有项目配置。

## 错误与范围
校验 400、未登录/禁用 401、非 admin/需改密码 403、不存在 404、版本冲突 409；业务错误 `{ok:false,message}`。需改密码沿用 `code: 'PASSWORD_CHANGE_REQUIRED'`。
按原计划保留财务记录，**本阶段没有 DELETE 接口，也没有单独删除凭证接口**（计划原文“新增/更新，无删除”）。若产品确定需要删除，请新增经审核的归档/删除策略与测试，不让前端自行假设 DELETE 可用。

## 验证与限制
- `node --test tests/*.test.mjs`：纯校验、建表 SQL 调用、真实 Express HTTP + 内存数据库替身，覆盖 admin A 新建/admin B 查询编辑、401/403（含昵称 admin 的 member）、附件保护、400/404/409、审计回调和事务提交/回滚调用。
- 启动接入用源码断言检查，不 import server.js，避免其自动启动和数据库副作用。
- **尚未做真实 MySQL 隔离库集成、重启后持久化、真实 session 端到端验证**。部署前需在隔离环境完成；禁止把现有 smoke 指向生产。
- 创建人/修改人及时间在记录事务内保存。全站 admin_audit_logs 复用现有 best-effort writeAudit：日志故障只记录服务器错误，不回滚已成功保存的记录。
