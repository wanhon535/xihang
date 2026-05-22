# 汐航项目说明与前端提示词

## 项目是干什么的

`汐航` 是一个公司内部统一访问平台，用来把内部系统入口、SSO 单点登录、用户权限管理和个人项目凭证管理集中到一个站点里。

它的核心目标是：

- 给员工提供一个统一的内部系统入口工作台。
- 支持钉钉扫码登录，后续可作为公司 SSO 平台入口。
- 管理员统一创建和分配用户，普通成员不能自行注册。
- 新建用户或重置密码后的用户，首次登录必须先修改密码。
- 管理员维护站点分组和内部系统入口。
- 每个用户有独立的个人凭证库，用来记录项目、系统、账号、密码、网址、IP、环境标签和备注。
- 个人凭证必须按用户隔离，普通用户只能看到自己的记录。

一句话概括：这是一个面向公司内部使用的 SSO 访问工作台 + 管理后台 + 个人项目账号密码库。

## 当前前端结构

前端是 Vite 多页面结构，页面在 `frontend/*.html`，脚本在 `frontend/src/*.js`，统一样式在 `frontend/src/styles.css`。

主要页面：

- `login.html`：登录页，支持钉钉扫码入口和管理员本地账号登录。
- `change-password.html`：首次登录或密码重置后的强制改密页。
- `index.html`：工作台首页，展示身份、站点统计、快捷入口和应用地图。
- `vault.html`：星钥库，个人项目凭证管理。
- `admin.html`：管理员后台，包含成员管理和站点管理。

当前产品命名：

- 产品名：`汐航`
- 首页：`工作台`
- 个人凭证功能：`星钥库`
- 管理后台：`管理中枢`
- 站点入口区域：`应用地图`

## 当前前端风格方向

前端应该是轻量、干净、对齐严谨的内部工具风格，不要做成营销落地页。

视觉方向：

- 浅色主背景，轻科技感，不要大面积暗黑。
- 左侧窄导航栏，主内容区域清晰分块。
- 首页应更像工作台，不是宣传页。
- 使用整齐的卡片网格、状态面板、项目分组列表。
- 按钮、输入框、卡片、标签高度要统一，避免错位。
- 内容密度适中，适合日常内部使用。
- 色彩以白、浅蓝、科技蓝、青色、薄荷绿为主，少量强调色即可。
- 不要使用过多渐变、装饰球、浮夸阴影或不规则布局。

## UI 重构提示词

下面这段可以直接复制给前端设计或代码模型使用：

```text
你是一个资深企业级前端设计师和前端工程师。请基于现有项目“汐航”重构全部前端页面，目标是做成一个公司内部使用的统一访问平台，包含工作台、星钥库、管理中枢、登录页和首次改密页。

项目定位：
这是一个公司内部 SSO 访问工作台。员工通过钉钉扫码或本地账号登录后，可以在工作台进入内部系统；管理员可以维护用户和站点；每个员工有自己的星钥库，用来按项目/系统保存账号、密码、网址、IP、环境标签和备注。

核心页面：
1. 登录页 login.html
   - 产品名：汐航
   - 支持钉钉扫码登录按钮
   - 支持管理员本地账号密码登录
   - 页面要简洁、高级、可信，不要营销风
   - 底部居中显示版本和公司版权信息

2. 首次改密页 change-password.html
   - 用户首次登录或管理员重置密码后必须进入
   - 表单包含当前临时密码、新密码、确认新密码
   - 视觉上和登录页保持一致

3. 工作台首页 index.html
   - 左侧窄导航栏
   - 顶部显示当前用户和退出按钮
   - 主区域用浅色规整布局
   - 首页包含：
     - 当前身份卡片
     - 应用分组数量
     - 站点入口数量
     - 快捷入口：星钥库、管理中枢、个人隔离说明
     - 应用地图：按分组展示内部系统入口
   - 应用入口必须使用统一高度卡片网格，卡片底部按钮和标签必须对齐
   - 搜索框用于搜索站点名称、说明或标签

4. 星钥库 vault.html
   - 展示名叫“星钥库”
   - 这是个人项目凭证库
   - 用户可以按项目/系统保存账号、密码、网址、IP、环境标签和备注
   - 左侧或主区域显示凭证列表，按项目/系统分组
   - 每条凭证卡片需要展示：
     - 项目/系统
     - 记录名称
     - 登录账号
     - 网址或 IP
     - 更新时间
     - 环境/标签
     - 操作按钮：编辑、复制账号、复制密码、查看密码、打开地址
   - 右侧为编辑表单，字段包括：
     - 记录名称
     - 登录账号
     - 项目/系统
     - 环境/标签
     - 密码
     - 网址或 IP
     - 备注
     - 是否收藏
   - 保存记录的样式必须像企业凭证管理工具，不能像普通表单堆叠
   - 操作按钮必须对齐，卡片高度和信息层级要稳定

5. 管理中枢 admin.html
   - 只有管理员可进入
   - 包含两个 Tab：成员档案、站点矩阵
   - 成员档案支持创建用户、设置角色、状态、重置密码
   - 普通成员不能注册，只能由管理员创建
   - 新建或重置密码后，用户首次登录必须改密码
   - 站点矩阵支持维护应用分组和站点入口

设计要求：
- 整体风格：轻科技、干净、企业级、对齐严谨
- 不要做营销首页，不要大 Hero 宣传，不要过多装饰
- 不要大面积暗色背景，主工作区使用白色和浅蓝灰背景
- 卡片圆角控制在 8px 左右
- 输入框、按钮、标签、卡片间距要统一
- 不允许文字挤出按钮或卡片
- 移动端要自适应，不允许横向溢出
- 页面底部保留版本和公司版权信息

必须保留的前端 DOM ID：
- 全局：userName, logoutBtn
- 首页：accountName, accountRole, groupCount, siteCount, directorySummary, searchInput, content
- 登录页：loginBtn, passwordLoginForm, usernameInput, passwordInput, errorText
- 改密页：changePasswordForm, currentPasswordInput, nextPasswordInput, confirmPasswordInput, errorText
- 管理页：adminEditor, saveBtn, addGroupBtn, saveStatus, usersPanel, sitesPanel, userList, userStatus, createUserForm, newUsername, newNick, newPassword, newRole
- 星钥库：newCredentialBtn, vaultSearchInput, categoryFilterInput, favoriteOnlyInput, credentialCount, credentialList, credentialForm, formTitle, clearFormBtn, deleteCredentialBtn, saveCredentialBtn, formStatus, credentialTitleInput, credentialUsernameInput, credentialCategoryInput, categoryList, credentialTagsInput, credentialPasswordInput, togglePasswordInputBtn, generatePasswordBtn, strengthBar, strengthText, credentialUrlInput, credentialNotesInput, credentialFavoriteInput, generatorLengthInput, generatorLengthText, generatorUpperInput, generatorLowerInput, generatorNumberInput, generatorSymbolInput, applyGeneratedPasswordBtn, copyGeneratedPasswordBtn, generatedPasswordPreview

技术约束：
- 不要破坏现有 API 调用
- 不要改接口路径
- 不要加入公开注册
- 不要把个人星钥库记录展示给其他用户
- 列表接口不要展示明文密码
- 密码只能通过查看或复制操作按需读取
- 站点 SSO 入口仍通过后端 authorize 接口跳转

交付要求：
- 更新 HTML 和 CSS，使所有页面风格统一
- 保持 JS 事件绑定可用
- 构建必须通过 npm.cmd run build:frontend
- 后端语法检查必须通过 npm.cmd run check
```

## 页面内容建议

推荐页面文案：

- 产品名：汐航
- 登录页标题：欢迎回到汐航
- 首页标题：工作台
- 首页说明：今天从这里进入内部系统
- 星钥库标题：星钥库
- 星钥库说明：按项目或系统归档账号、密码、网址、IP 和备注
- 管理页标题：管理中枢
- 应用入口区域：应用地图
- 用户管理区域：成员档案
- 站点管理区域：站点矩阵

## 星钥库的数据理解

星钥库虽然底层字段叫 `category`、`title`、`url`，但前端语义建议这样理解：

- `category`：项目/系统，例如“云南项目”“公司官网”“服务器”
- `title`：具体记录名称，例如“运营后台管理员”“生产数据库账号”
- `loginUsername`：登录账号
- `password`：密码
- `url`：网址、域名、IP 或 IP:端口
- `tags`：环境/标签，例如“生产”“测试”“数据库”“堡垒机”
- `notes`：备注
- `isFavorite`：是否常用

## 启动命令

后端：

```powershell
npm.cmd run dev:backend
```

前端：

```powershell
npm.cmd run dev:frontend
```

访问：

```text
http://127.0.0.1:2223/login.html
```

## 验证命令

```powershell
npm.cmd run build:frontend
npm.cmd run check
node --check backend/src/db.js
node --check frontend/src/main.js
node --check frontend/src/vault.js
```
> 当前产品名统一使用“汐航”。
