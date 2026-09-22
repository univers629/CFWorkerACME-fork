<div align="center">

# 🔐 CertHub · SSL 证书助手

**基于 Cloudflare Worker / EdgeOne Pages 的全自动化 SSL 证书申请与下发平台**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![EdgeOne](https://img.shields.io/badge/Tencent-EdgeOne-00A4FF?logo=tencentqq&logoColor=white)](https://edgeone.ai/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Hono](https://img.shields.io/badge/Built%20with-Hono-E36002)](https://hono.dev/)

[English](#english) · [快速部署](#-一键部署) · [在线演示](#-在线演示) · [使用文档](#-配置说明) · [常见问题](#-常见问题)
</div>


---

## 📖 项目介绍

**CertHub（SSL 证书助手）** 是一个 **免费、开源、全自动化** 的 SSL 证书申请与下发平台，依托 Cloudflare Workers / Tencent EdgeOne Pages 等 Serverless 平台运行，**无需服务器即可部署**。

通过自动化的 CNAME 与 DNS 操作，平台可以全自动完成域名验证、申请证书并将其同步下发到任意服务器或客户端。

### ✨ 核心优势

- 🚀 **无服务器部署**：依托 Cloudflare Worker / EdgeOne Pages，**完全免费**，亦支持私有化部署
- 🔁 **一次配置，永久使用**：支持 DCV 代理与自动验证，**只需设置一次 CNAME 记录**即可永久续期
- 🏢 **多服务器同步**：相比 `acme.sh` 单机使用，更适合 **多服务器、内网共享** 同一证书的场景
- 🌐 **多 CA 支持**：内置 `Let's Encrypt`、`ZeroSSL`、`Google Trust Service`、`SSL.com` 四大主流 CA
- 🎨 **现代化管理后台**：终端风格 UI，支持证书全生命周期管理（申请 / 续期 / 吊销 / 下载 PFX / ZIP）
- 🔌 **完整 API**：提供完整 RESTful API，方便接入到 1Panel / 宝塔 / 自建系统

---

## 🖼️ 项目截图

### 管理控制台

> 终端风格的实时仪表盘，一目了然查看证书总览、订单状态与最新动态。
<p align="center">
  <img src="images/QQ20250506-153642.png" alt="CertHub 证书详情页" width="900" />
</p>



### 证书订单详情

> 支持查看完整签发流程进度，并提供 **下载证书 / 下载密钥 / ZIP / PFX / 续期 / 吊销** 等一站式操作。

<p align="center">
  <img src="images/QQ20250506-153705.png" alt="CertHub 管理控制台" width="900" />
</p>

---

## 🌍 在线演示

- 演示站点：<https://newssl.524228.xyz/>

> ⚠️ 演示平台 **不会主动泄漏您的密钥数据**，但出于安全考虑，建议在生产环境使用自己的 Cloudflare 账号私有化部署。

---

## 🚀 一键部署

| Cloudflare Workers (全球) | EdgeOne Pages (国际) | EdgeOne Pages (中国) |
| :---: | :---: | :---: |
| [<img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" width="220" />](https://deploy.workers.cloudflare.com/?url=https://github.com/univers629/CFWorkerACME-fork) | [<img src="https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg" alt="使用 EdgeOne Pages 部署" width="220" />](https://edgeone.ai/pages/new?project-name=cfworker-acme&repository-url=https://github.com/univers629/CFWorkerACME-fork&build-command=npm%20run%20build-eo&install-command=npm%20install&output-directory=public&root-directory=./) | [<img src="https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg" alt="使用 EdgeOne Pages 部署" width="220" />](https://console.cloud.tencent.com/edgeone/pages/new?project-name=cfworker-acme&repository-url=https://github.com/univers629/CFWorkerACME-fork&build-command=npm%20run%20build-eo&install-command=npm%20install&output-directory=public&root-directory=./) |

> 📌 **部署按钮只会拉取按钮链接里写死的仓库**。想部署自己的 Fork：
>
> 1. 先 Fork 本仓库；
> 2. 把上面的链接改成 `https://deploy.workers.cloudflare.com/?url=https://github.com/<你的用户名>/<你的仓库名>` 再打开；
> 3. Cloudflare 面板里确认构建命令是 `npm run build`、部署命令是 `npx wrangler deploy`（默认值即如此）。
>
> ⚠️ 历史版本的 README 中按钮指向 `.../CFWorkerACMEs`（结尾多了一个 `s`），该仓库并不存在，点进去只会失败——现已修正为真实仓库。
>
> 💡 长期维护更推荐 **[GitHub Actions 自动部署](#-部署到-cloudflaregithub-actions-自动部署--推荐用于长期维护)**：密钥统一放在仓库 Secrets，push 即部署，还能自动建 D1 并验证初始化。

由于腾讯云EdgeOne Pages目前尚且不支持D1数据库，如果使用腾讯云EdgeOne Pages部署，需要使用外部数据库，参考变量部分

---

## 🆕 近期修复与升级（v2.1）

| 问题 | 现象 | 修复 |
| :--- | :--- | :--- |
| 前端依赖没被安装 | Cloudflare 构建日志里几百条 `TS2307: Cannot find module 'antd' / 'zustand' / 'dayjs'` | 根目录改为 npm workspaces，`npm install` 一次装完根 + `frontend/`，`npm run build` 相应改为 `npm run build --workspace cfworker-acme-frontend` |
| TypeScript 6 弃用 `baseUrl` | `frontend/tsconfig.json(28,5): error TS5101: Option 'baseUrl' is deprecated`，构建直接中断 | 去掉 `baseUrl`，`paths` 改为 `"./src/*"` 相对写法；根目录显式锁 `typescript@^5.9.3` |
| Workers Sites 已废弃 | `wrangler.jsonc` 用 `site.bucket` + 代码里 `__STATIC_CONTENT_MANIFEST`，需要额外的 KV 命名空间 | 升级为 Workers 静态资源（`assets` + `not_found_handling: single-page-application` + `run_worker_first` API 前缀），静态文件不再经过 Worker |
| D1 占位符导致部署失败 | `database_id: "<database-id>"` 不是合法 UUID，`wrangler deploy` 必失败 | 删除 `database_id`，交给 wrangler ≥4.45 的自动资源创建；已建库的用户把 ID 填回即可 |
| 定时任务空转 | `scheduled()` 只打日志，Cloudflare 上的订单永远不会自动推进/续期 | `scheduled()` 改为调用 `certs.Processing(env)` |
| 依赖臃肿 | 装了 900+ 个包（`@serverless-devs/s`、`edgeone` 及其 CLI 依赖、已被弃用的 `request`） | `edgeone`/`@edgeone/ef-types` 降为 devDependencies，移除从未被引用的 `@serverless-devs/s` |
| 部署按钮 404 | 按钮指向不存在的 `CFWorkerACMEs` | 修正为 `CFWorkerACME`，并补充 Fork 部署说明 |
| Worker 里 import 了 `wrangler` | `src/certs.ts` 有一行从未使用的 `import {errors} from "wrangler"`，打包时要解析 10MB+ 的开发期 CLI 包；一旦安装跳过 devDependencies 就直接打包失败 | 删除该行 |
| 根 tsconfig 把前端代码也编译了 | 编辑器 / `tsc --noEmit` 报 1700+ 条 React 相关错误 | 根 `tsconfig.json` 加 `include: ["src/**/*.ts"]` + `exclude: ["frontend"]` |
| fork 后 favicon 丢失、`public/` 全被忽略 | `.gitignore` 里裸写 `public`，把 `frontend/public/` 也一起忽略了 | 改为 `/public/*`；补上 `frontend/public/favicon.svg`；构建产物 `public/index.html` 不再入库 |
| Node 版本不固定 | 构建镜像默认版本会变 | 新增 `.nvmrc`（22），并新增 `Build Check` CI 复刻 Workers Builds 流程 |

### 🧹 v2.2：清掉历史遗留 + 类型报错归零

| 项目 | 说明 |
| :--- | :--- |
| **类型报错 59 → 0** | `npx tsc --noEmit` 现在完全干净。修的都是真实隐患：`c.get("admin")` 未声明上下文变量（12 处 TS2769）、`globalThis.crypto` 缺声明（5 处）、`node-forge` 的 `util.ByteBuffer` 与 ASN.1 子节点 `undefined`（4 处）、`import {a} from "xior/xior-D_RKcIOK"` 指向 xior 内部哈希文件（1 处，xior 一升级就会崩） |
| **`D1Bindings` 类型** | `certs.ts` 这类直接操作 D1 的模块改用 `Bindings & { DB_CF: D1Database }`；`scheduled()` 在缺绑定时打印明确日志而不是中途 TypeError |
| **`public/static/` 已删除** | 19MB 历史遗留（`maple-min.ttf` 17.7MB、bootstrap/echarts/旧面板脚本），React 前端完全不再引用。部署上传体积大幅下降 |
| **`.idea/` 已删除** | 上游把 IDE 配置提交进了仓库（9 个文件），已移除并保留在 `.gitignore` |
| **`UPDATE.bat` 已删除** | 18KB 的“皮卡丘 Git 工具”Windows 批处理菜单，与本项目功能无关 |
| **`package.save.json` 已删除** | 早期 `package.json` 的备份副本（本身还是非法 JSON） |
| **`schema.sql` 已删除** | 与 `schema.set.sql` 重复且没有 `IF NOT EXISTS`（重跑会失败）；注释已统一指向 `schema.set.sql` |
| **`_Placeholder.tsx` 已删除** | 前端未引用的占位组件 |
| **`docker-image.yml` 已删除** | 上游 Docker Hub 发布工作流：登录凭据是上游的、推送目标是 `pikachuim/*`，在 Fork 里每次都会失败 |
| **`src/basic.ts` 变量清理** | Node/Docker 模式原来只透传 16 个与证书毫无关系的云盘变量（onedrive/baiduyun/115…），现在改为透传真实变量，且 `MAIL_KEYS` 与 `OPLIST_MAIL_KEYS` 两种写法都识别 |
| **`.env.example` 补全** | 原来是 0 字节空文件，现在给出完整变量模板（数据源/邮件/鉴权/DCV/CA 四组） |
| **`docker-compose.yml` 修正** | 服务名 `oplist-api-server` → `cfworker-acme`；原来直接拉上游镜像 `pikachuim/newssl:latest`，改为 `build: .` 用你自己的代码构建 |
| **`DCV_TOKEN` 只认 Global API Key** | `src/agent.ts` 固定发 `X-Auth-Email` + `X-Auth-Key`，填 scoped API Token 会报 `6003 Invalid request headers` | 改为按 token 形态自动选择鉴权头，两种凭证都能用（推荐 scoped Token，权限可限定到单个域名） |
| **关闭注册后可被绕过** | `REGISTER_ALLOW=false` 只在「发验证码」阶段拦截；若库里已有 `flag=0` 的待验证行（管理员在用户点了发码之后才关闭注册），直接调 `/setup/` 仍能完成注册——实测复现 | 写库入口 `userRegs` 对新注册（`flag=0`）二次校验开关；同时补上验证码 5 分钟时效（原来旧验证码可永久复用） |
| **Actions 日志泄漏隐私**（公开仓库） | `wrangler deploy` 会把 `vars` 的明文值（发件邮箱、站点域名、DCV 域名、各类密钥）打印到日志；公开仓库的 Actions 日志任何人可见，而 GitHub 只自动脱敏 `secrets.*` 来源的值 | 敏感项（20+ 项）不再写入 wrangler 配置，改由 `wrangler secret bulk` 下发；其余值显式 `::add-mask::`；生成脚本与摘要不再回显具体值；CI 增加隐私回归测试（LEAKCANARY 哨兵值） |
| **`NOTIFY_*` 是死开关** | 系统管理页能点，但后端没有任何代码消费——点了完全没反应 | 新增 `src/notify.ts` + `src/expiry.ts` 真正接上：签发成功/失败在状态机里触发，到期提醒由 cron 扫描（含 `Apply.notified` 去重） |
| **新增 Telegram 推送** | — | 参考 cloud-mail：Bot Token + 多 Chat ID + 开关 + 测试按钮，配置在系统管理页；消息只发给指定会话，不接收任何入站消息 |
| **初始化接口无鉴权，可被抢注管理员**（严重） | `/setup` 原先只检查 `INITIALIZED` 标记，**没有任何鉴权**。站点未初始化时，任何人扫到域名即可 `POST /setup` 把自己写成管理员——实测完整复现：攻击者无凭据拿到 `is_admin=1`、能用自己的密码登录、还能篡改站点标题与域名 | 改为 **fail-closed 三模式**：`preset`（预置 `ADMIN_MAIL`+`ADMIN_PASS`，首次访问自动建号、向导不开放）／`token`（向导开放但需 `SETUP_TOKEN`）／`locked`（未配置则直接拒绝，默认态）。密钥经 `wrangler secret put` 注入，不进配置与日志 |

### 🤖 v2.3：内置 GitHub Actions 部署（参考 cloud-mail）

| 新增 | 说明 |
| :--- | :--- |
| [`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml) | 仓库 Secrets/Variables → 构建 → 查/建 D1 → 部署 → `/bootstrap` 验证 `db_ok=true` → 部署摘要。没配令牌时自动跳过，不会给 push 挂红叉 |
| [`wrangler.action.jsonc`](wrangler.action.jsonc) | 带 `${占位符}` 的部署模板，密钥不进仓库 |
| [`scripts/gen-wrangler-config.mjs`](scripts/gen-wrangler-config.mjs) | JSON 安全的占位符替换（不像 `sed` 会被值里的 `&`、`\|`、`"` 破坏），只打印"是否已设置"、不打印密钥 |
| `Build Check` 新增校验 | 每次 CI 都会用假值跑一遍模板生成 + `wrangler deploy --dry-run -c`，模板写错会立刻暴露 |


---

## 🛠️ 技术栈

| 层级 | 技术 |
| :--- | :--- |
| **运行时** | Cloudflare Workers · EdgeOne Pages Functions · Node.js (Docker) |
| **后端** | [Hono](https://hono.dev/) · [acme-client](https://github.com/publishlab/node-acme-client) · `node-forge` · `crypto-js` |
| **前端** | React · Vite · TypeScript |
| **存储** | Cloudflare D1 (SQLite) |
| **邮件** | [Resend](https://resend.com/) |

---

## 📦 本地开发与部署

### 1. 克隆代码

```bash
git clone https://github.com/univers629/CFWorkerACME-fork.git
cd CFWorkerACME
```

### 2. 安装依赖

```bash
npm install        # npm workspaces：根依赖 + frontend/ 前端依赖一次装完
```

> 老版本需要额外跑一次 `npm run web-install` 单独装前端依赖；现在已由 workspaces 统一处理，
> `npm run web-install` 仍保留但等同于 `npm install`。

### 3. 配置环境变量

参考下方示例创建并修改 `wrangler.jsonc`（仓库根目录）。**仓库里已经带了一份可用的 `wrangler.jsonc`，一般只需要把 `vars` 里的空值填上即可。**

> 💡 想保留一份带真实密钥、又不想提交到 git 的配置时，复制一份到 `wrangler.encrypt.jsonc`（该文件已在 `.gitignore` 中）：
>
> ```bash
> cp wrangler.jsonc wrangler.encrypt.jsonc   # 然后 npm run deploy-cf:test
> ```

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cfworker-acme",
  "main": "src/cfapp.ts",
  "compatibility_date": "2025-03-10",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    // ===== 数据库 =====
    "DB_SOURCE": "d1",                       // d1 / mysql / prisma
    // "DB_MYSQL_URL":  "",                  // DB_SOURCE=mysql 时使用，二选一
    // "DB_MYSQL_HOST": "", "DB_MYSQL_PORT": "3306",
    // "DB_MYSQL_USER": "", "DB_MYSQL_PASS": "", "DB_MYSQL_NAME": "",
    // "DATABASE_URL":  "",                  // DB_SOURCE=prisma 时使用

    // ===== 邮件通知 =====
    "MAIL_KEYS": "",                         // Resend API Key
    "MAIL_SEND": "noreply@example.com",      // 发件邮箱

    // ===== 安全 / 人机验证 =====
    "AUTH_KEYS": "",                         // Turnstile / hCaptcha / reCAPTCHA 的 Secret Key
    "SITE_KEYS": "",                         // Turnstile / hCaptcha / reCAPTCHA 的 Site Key

    // ===== DCV 自动验证代理（Cloudflare）=====
    "DCV_AGENT": "",                         // DCV 代理域名（根域名）
    "DCV_EMAIL": "account@example.com",      // CloudFlare 账号邮箱
    "DCV_TOKEN": "",                         // CloudFlare API Key / Token
    "DCV_ZONES": "",                         // CloudFlare Zone ID

    // ===== CA 厂商配置 =====
    "GTS_useIt": "",     "GTS_keyMC": "", "GTS_keyID": "", "GTS_KeyTS": "",  // Google Trust Service
    "SSL_useIt": "true", "SSL_keyMC": "", "SSL_keyID": "", "SSL_KeyTS": "",  // SSL.com
    "ZRO_useIt": "true", "ZRO_keyMC": "", "ZRO_keyID": "", "ZRO_KeyTS": ""   // ZeroSSL
  },
  // ===== 静态资源（前端构建产物）=====
  // 旧写法是 Workers Sites："site": { "bucket": "./public" }，已废弃。
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/admin/*", "/bootstrap", "/login/*", "..."]
  },
  // ===== 数据库 =====
  // 不写 database_id：wrangler >= 4.45 会自动创建 D1 并把 ID 回填到配置里。
  "d1_databases": [
    {
      "binding": "DB_CF",              // 代码里用的名字（env.DB_CF），一般不用改
      "database_name": "cfworker-acme" // 跟上面的 "name" 保持一致，面板里好对号
    }
  ],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "triggers": { "crons": ["*/5 * * * *"] }
}
```

### 4. 本地调试

```bash
# Cloudflare Workers 本地调试（默认使用 wrangler.jsonc）
npm run dev-cf

# Cloudflare Workers 本地调试（使用 wrangler.encrypt.jsonc，含真实密钥时使用）
npm run dev-cf:test

# EdgeOne Pages 本地调试
npm run dev-eo

# 仅前端调试（http://localhost:5173）
npm run web-dev

# Node.js 自托管模式调试（不依赖 Workers / EdgeOne）
npm run dev-js
```

### 5. 部署到云端

#### ① 部署到 Cloudflare Workers（命令行）

```bash
# 一条命令：构建前端 → 自动创建并绑定 D1 → 推送 Worker
npm run deploy-cf

# 使用加密配置文件部署
npm run deploy-cf:test
```

> ✅ **D1 数据库不需要手动创建**：`wrangler.jsonc` 里只写了 `binding` 和 `database_name`
> （默认 `cfworker-acme`，**与 Worker 同名**，在面板里一眼就能对上）：
> wrangler ≥ 4.45 会在部署时自动创建数据库、回填 `database_id`（自动资源创建默认开启，可用 `--no-x-provision` 关闭）。
> 表结构同样不用手动执行 `schema.set.sql`：首次请求会运行 `src/db/migrations` 里的幂等迁移。
>
> 已经手动建过库的老用户：把原来的 `database_id` 填回 `d1_databases[0].database_id` 即可，数据不会丢。

#### ② 部署到 Cloudflare（Git 集成 / Workers Builds，也就是「一键部署」按钮背后的机制）

在 Cloudflare 面板里给仓库配置构建时，字段照下面填即可（默认值基本就是这样）：

| 配置项 | 值 |
| :--- | :--- |
| 构建命令 Build command | `npm run build` |
| 部署命令 Deploy command | `npx wrangler deploy` |
| 根目录 Root directory | 仓库根目录（留空） |
| Node 版本 | 20+（仓库已带 `.nvmrc`；也可在面板加环境变量 `NODE_VERSION=22`） |

构建流程 = `npm ci` → `npm run build`（vite 产物写入 `public/`）→ `npx wrangler deploy`。

> 🔍 **构建失败排查表**（v2.1 之前的版本必定失败）
>
> | 日志关键字 | 原因 | 处理 |
> | :--- | :--- | :--- |
> | `TS2307: Cannot find module 'antd' / 'zustand' / 'dayjs'` | 只装了根依赖，`frontend/` 的依赖没装 | 升级到 v2.1（npm workspaces）；或把安装命令改为 `npm install && npm --prefix frontend ci` |
> | `TS5101: Option 'baseUrl' is deprecated` | 新版 TypeScript 把 `baseUrl` 列为废弃 | 升级到 v2.1；或给 `frontend/tsconfig.json` 加 `"ignoreDeprecations": "6.0"` 临时绕过 |
> | `database_id ... is not a valid UUID` / `A D1 database with ID "<database-id>" was not found` | 配置里还是 `<database-id>` 占位符 | 删掉 `database_id` 让 wrangler 自动创建，或执行 `npx wrangler d1 create cfworker-acme` 后把真实 ID 填回 |
> | 部署成功但页面白屏、`/assets/*.js` 404 | 前端没构建，`public/` 里是仓库中过期的 `index.html` | 确认构建命令包含 `npm run build` |

#### ③ 部署到 Cloudflare（GitHub Actions 自动部署 ⭐ 推荐用于长期维护）

思路参考 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 的 Action 部署方式（[官方文档](https://doc.skymail.ink/guide/action.html)）：
**不用把仓库接到 Cloudflare，也不用在本地配 ~/.wrangler 凭据**——密钥存在仓库 Settings 里，每次 push 自动构建 + 部署。

一次性准备：仓库 `Settings → Secrets and variables → Actions`

| 名称 | 必需 | 用途 |
| :--- | :---: | :--- |
| `CLOUDFLARE_API_TOKEN` | ✅ | Cloudflare API 令牌，模板 `Edit Cloudflare Workers`，另加 `D1:Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账户 ID（控制台右侧栏可复制） |
| `MAIL_KEYS` / `MAIL_SEND` | ⭕ | Resend 密钥 / 发件人。**不填也能部署**，但注册/找回密码要邮箱验证码，等于没法注册 |
| `ADMIN_MAIL` + `ADMIN_PASS` | ⭕ | **强烈推荐**：预置管理员，首次访问自动建号、初始化向导不开放（防扫站抢注） |
| `SETUP_TOKEN` | ⭕ | 不想预置密码时的替代：向导开放但必须携带此令牌 |
| `AUTH_KEYS` | ⭕ | 人机验证 Secret（Turnstile）。只有开启验证码时才用，默认关闭 |
| `DCV_AGENT` / `DCV_EMAIL` / `DCV_TOKEN` / `DCV_ZONES` | ⭕ | DCV 自动验证代理（不填则只能每次手动加 DNS TXT 记录） |
| `NAME` | ❌ | Worker 名称，默认 `cfworker-acme` |
| `D1_DATABASE_NAME` | ❌ | D1 库名，**留空 = 与 `NAME`（Worker 名）同名**；只在想沿用已有库时才显式指定 |
| `D1_DATABASE_ID` | ❌ | 已有库的 UUID，填了就直接用它（最稳妥，不会误建新库）；不填则自动查同名库、没有就创建 |
| `CUSTOM_DOMAIN` | ❌ | 用完自己的域名访问，例如 `acme.example.com`；**留空则用 `xxx.workers.dev`** |
| `SITE_HOST` / `SITE_TITLE` | ❌ | 站点域名与标题（影响邮件里的链接与页面标题） |
| `GTS_*` / `SSL_*` / `ZRO_*` | ❌ | 各 CA 的 EAB 参数（`*_useIt` 填 `true` 表示启用） |

> 条目可以放在 **Secrets** 或 **Variables** 里，两种都识别（敏感值建议用 Secrets）。
> 没配 `CLOUDFLARE_API_TOKEN` 时工作流会**自动跳过**，不会给每次 push 挂红叉。

#### 🔒 公开仓库的日志隐私（重要）

**Actions 日志对任何人可见**（公开仓库无需登录即可查看），而 `wrangler deploy`
会把配置里 **所有 `vars` 的明文值**打印出来：

```
Your Worker has access to the following bindings:
env.MAIL_SEND ("me@yourdomain.com")        Environment Variable
env.SITE_HOST ("acme.yourdomain.com")      Environment Variable
```

GitHub 只会自动脱敏来自 `secrets.*` 的值，**不会**脱敏 `vars.*`。
所以本项目做了三层防护：

| 措施 | 说明 |
| :--- | :--- |
| **敏感项不进配置** | 邮箱、域名、各类密钥共 20+ 项由生成脚本识别后**完全不写入 wrangler 配置**，改由 `wrangler secret bulk` 下发。这样绑定表里根本不会出现它们 |
| **显式 `::add-mask::`** | 对配置里仍存在的值（如 `routes` 里的自定义域名——建路由必须写进配置）显式脱敏，输出时替换为 `***` |
| **不回显** | 预检、摘要、生成脚本一律只报告"是否已配置"，不打印具体值 |

> ✅ 这些不是空话：CI 里有一条**隐私回归测试**（`Build Check` 工作流），
> 用带 `LEAKCANARY` 标记的假值跑一遍生成流程，只要敏感值出现在日志或配置里就直接失败。
>
> ⚠️ **仍然要避免的做法**：不要把密钥填进仓库的 **Variables**（用 Secrets）；
> 因为 Variables 的值本身在仓库设置页里对协作者可见。本项目做了脱敏，
> 但 Secrets 是更稳妥的选择。

#### 🔑 到底要准备几个令牌？

| 令牌 | 数量 | 必需 | 说明 |
| :--- | :---: | :---: | :--- |
| Cloudflare API Token | **1 个** | ✅ | 部署用（见下表权限）。**这一个就够部署** |
| Cloudflare Account ID | **1 个** | ✅ | 不是密钥，控制台右侧栏复制即可 |
| Resend API Key | 1 个 | 想注册用户就要 | 免费注册 <https://resend.com> 拿 Key |
| Cloudflare API Token（DNS） | 1 个 | 想自动续期就要 | 给 DCV 用，**可以和上面部署那个合并成同一个 Token**（多勾一个 `Zone → DNS → Edit`） |
| CA 的 EAB（GTS/SSL/ZRO） | 每个 CA 一组 | ❌ | 不用 EAB 的 CA 可以直接跳过 |

> 💡 **最少 1 个 Cloudflare API Token + 1 个 Account ID 就能部署成功**。
> 其余都是「部署后想让功能完整」才需要。

Cloudflare API Token 建议勾选（在 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 自定义模板）：

| 权限 | 作用域 | 为什么需要 |
| :--- | :--- | :--- |
| `Workers Scripts` → **Edit** | Account | 部署 Worker（首次部署新 Worker 需要 `Admin` 级别的 Workers 权限） |
| `Workers Routes` → **Edit** | Zone（你的域名） | 只有设了 `CUSTOM_DOMAIN` 才需要：自动建 DNS 记录 + 绑域名 |
| `D1` → **Edit** | Account | 自动查/建 D1 数据库（[D1 文档](https://developers.cloudflare.com/d1/)） |
| `Zone` → **DNS** → **Edit** | Zone（你的域名） | 只有要用 DCV 自动续期才需要 |

> ⚠️ `Edit Cloudflare Workers` 这个官方模板**不含 D1 权限**（[模板权限表](https://developers.cloudflare.com/fundamentals/api/reference/template/)），
> 所以要么在模板基础上手动加 `D1: Edit`，要么直接用自定义模板勾上面四项。
> 不加也能部署：工作流会检测到建库失败，退回到 wrangler 的自动资源创建。

#### 🌐 自定义域名：不用去 Cloudflare 后台点

**Actions 会替你做完**——这正是参考 cloud-mail 的地方：

```jsonc
// wrangler.action.jsonc 里的这段，CUSTOM_DOMAIN 有值时才生效
"routes": [{ "pattern": "${CUSTOM_DOMAIN}", "custom_domain": true }]
```

`custom_domain: true` 表示让 Cloudflare **自动创建 DNS 记录并签发边缘证书**，
不需要你手动加 CNAME/A 记录，也不需要去 `Workers → Settings → Domains & Routes` 点添加
（[Custom Domains 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)）。

前提条件只有两个：

1. 这个域名（或其根域）**已经托管在同一个 Cloudflare 账号下**（即已是 active zone）；
2. 你的 Token 有该 zone 的 `Workers Routes: Edit`（[权限说明](https://developers.cloudflare.com/workers/authorization/workers/)）。

> 不设 `CUSTOM_DOMAIN` 也完全可用，只是地址是 `https://cfworker-acme.<你的子域>.workers.dev`。
> 之后想加域名，补上这个变量再跑一次工作流即可，**不需要重新建库、数据不丢**。

#### 🔐 管理员账号：两种方式，**强烈推荐预置**

> ⚠️ **重要背景**：早期版本的 `/setup` 初始化接口**没有任何鉴权**——只要站点还没初始化，
> 任何人扫到域名都能抢先 POST 一次把自己变成管理员（`is_admin=1`）并标记初始化，
> 从而完全接管站点。**现已修复为 fail-closed**，并新增「预置管理员」模式。
> 如果你部署过旧版本且站点仍处于未初始化状态，请尽快升级。

三种模式（按优先级自动判定）：

| 模式 | 触发条件 | 安全性 | 说明 |
| :--- | :--- | :--- | :--- |
| **preset** ⭐ | 配了 `ADMIN_MAIL` + `ADMIN_PASS` | **最高** | 首次访问自动创建管理员，**初始化向导完全不开放**，没有任何可被抢注的入口 |
| token | 只配了 `SETUP_TOKEN` | 中 | 向导仍可用，但提交时必须填对令牌 |
| locked | 三者都没配 | 安全但不可用 | 初始化接口直接拒绝（默认态），需补配置后重跑 |

**推荐做法**（推荐 preset）：

```yaml
# 仓库 Settings → Secrets and variables → Actions
ADMIN_MAIL:  you@example.com     # 管理员登录邮箱
ADMIN_PASS:  <你的强密码>         # 明文即可，部署时自动转 SHA256；填 64 位 hex 则按已哈希处理
```

> 🔒 `ADMIN_PASS` 与 `SETUP_TOKEN` 由工作流用 `wrangler secret put` 写入，
> **不会出现在 wrangler 配置、仓库或部署日志里**；`ADMIN_MAIL` 不敏感，走普通变量。
> 两个 secret 在**首次部署之后**写入（Worker 还不存在时 `secret put` 会失败），
> 之后站点会在首次访问时自动建号并标记初始化。

如果你想自己点一遍向导（token 模式）：

| 向导里要填 | 对应变量 | 说明 |
| :--- | :--- | :--- |
| 初始化令牌 | `SETUP_TOKEN` | **必填**（token 模式下） |
| 站点域名 | `SITE_HOST` | 默认自动填当前访问的域名 |
| 站点标题 | `SITE_TITLE` | 页面标题 |
| 管理员邮箱 | — | **就是你的登录账号** |
| 管理员密码 | — | **在这里设置**，前端 SHA256 后入库 |
| 邮件功能开关 + Resend Key | `MAIL_KEYS` / `MAIL_SEND` | 也可以在向导里填 |

流程（token 模式）：部署完成 → 打开站点 → 自动跳 `/setup` → 填入 `SETUP_TOKEN` 与管理员信息 → 提交 → 用刚设的邮箱密码登录。
**初始化标记 `INITIALIZED=true` 写入后该页面即失效**，所以密码要自己记牢。

> 想改这些配置不用重新部署：登录后进 **系统管理 → 配置**（`/admin/confs`），
> 邮件、DCV、注册策略、CA 凭据都能在线改，改完立即生效。
> 注意 `ADMIN_MAIL` **不在**可在线编辑的白名单里——它属于部署期配置，改了要重新部署。

#### 📢 Telegram 推送（参考 cloud-mail）

证书签发成功 / 失败 / 即将到期 / 已过期，都能推到 Telegram。配置在
**系统管理 → 配置 → Telegram 推送**：

| 配置项 | 说明 |
| :--- | :--- |
| `TG_BOT_ENABLED` | 总开关，默认关闭 |
| `TG_BOT_TOKEN` | 在 [@BotFather](https://t.me/BotFather) 创建机器人后获得，形如 `123456:ABC-DEF...`（**密钥，只回显是否已配置**） |
| `TG_CHAT_ID` | 接收会话 ID，**支持多个**（逗号 / 分号 / 空格分隔）。私聊为正数，群组为负数（`-100…`） |

配置完点「发送测试消息」即可验证，无需等到真的签发证书。

> 🔒 **安全性**：消息只会发给你填写的 Chat ID。
> 本系统**不接收**任何 Telegram 消息——没有 webhook，也不轮询 `getUpdates`，
> 代码里唯一的出站调用就是 `sendMessage`。所以别人即使搜到你的 Bot 用户名并点了
> `/start`，也**收不到**任何推送（我们根本不知道他的 Chat ID）。这与 cloud-mail 的行为一致。
>
> ⚠️ **唯一要注意**：推送到**群组**时，群里所有成员都能看到消息内容（含域名、用户邮箱、订单号）。
> 请只用私聊或只有你自己的私有群；建议在 @BotFather 用 `/setjoingroups` 禁止他人把机器人拉进群。
>
> ℹ️ 若用私聊，需要**你先给机器人发一句话**（点 Start），否则 Telegram 会拒绝机器人主动发起会话——
> 这是 Telegram 的平台规则，不是本项目限制。

**四个通知开关**（`NOTIFY_ON_SUCCESS` / `NOTIFY_ON_FAIL` / `NOTIFY_ON_EXPIRE7` / `NOTIFY_ON_EXPIRED`）
现在真正生效了：前两个在证书状态机里触发，后两个由 cron 定期扫描（`src/expiry.ts`）。
到期提醒会写入 `Apply.notified` 去重，**同一张证书的同一类提醒只推一次**；续期成功后自动清空，下个周期可重新提醒。

#### 🚫 关闭注册（防止陌生人白嫖）

和 cloud-mail 的「网站设置 → 允许注册」开关等价，我们的实现在 **系统管理 → 配置 → 注册策略**：

| 配置项 | 作用 |
| :--- | :--- |
| `REGISTER_ALLOW` | **关闭后登录页直接隐藏「注册」Tab**，后端发码与写库两处都会拒绝 |
| `REGISTER_CODE` | 注册邀请码。留空=不校验；非空时必须在注册时填对（在发码阶段校验） |
| `DEFAULT_QUOTA` | 新用户默认证书配额，`-1` 不限 |

> ⚠️ **改动有最多 60 秒延迟**：配置读取有 60 秒内存缓存（`src/db/conf.ts` 的 `CACHE_TTL_MS`）。
> 从管理页保存时会主动失效缓存，立即生效；直接改数据库则需要等缓存过期。
>
> 💡 想彻底关站（连注册入口都不留），关掉 `REGISTER_ALLOW` 后自己用管理员账号登录即可——
> 管理员是初始化向导里创建的，不受注册开关影响。

然后：`Actions → 🚀 Deploy to Cloudflare Workers → Run workflow`
（也可以在 `main` 分支上改动 `src/**`、`frontend/**`、`wrangler*.jsonc` 时自动触发。）

工作流做了什么：预检凭据与变量 → `npm ci` → `npm run build` → 查/建 D1 → 用
[`scripts/gen-wrangler-config.mjs`](scripts/gen-wrangler-config.mjs) 把密钥写进 `wrangler.action.jsonc` 模板生成部署配置
（JSON 安全替换，不会被值里的 `&`、`|`、`"` 弄坏） → `wrangler deploy --dry-run` 预检 → 部署 → 请求 `/bootstrap` 确认 `db_ok=true`（首次请求会执行幂等迁移建表）→ 输出部署摘要。

本地想用同一套配置部署（不经过 Actions）：

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... MAIL_KEYS=... AUTH_KEYS=...
node scripts/gen-wrangler-config.mjs            # 生成 wrangler.action.local.jsonc（已 gitignore）
npx wrangler deploy -c wrangler.action.local.jsonc
```

| 部署方式 | 适合谁 | 密钥放哪 | 首次建库 |
| :--- | :--- | :--- | :--- |
| Deploy 按钮 / Workers Builds | 想点一下就跑起来 | CF 控制台 Variables | wrangler 自动创建 |
| **GitHub Actions** | 长期维护、想 push 即上线 | 仓库 Secrets/Variables | 工作流自动查/建 |
| 命令行 `npm run deploy` | 本地调试完直接发包 | 本地 `wrangler.jsonc` / `~/.wrangler` | wrangler 自动创建 |

#### ④ 部署到 EdgeOne Pages

```bash
# 需在末尾追加 EdgeOne Token
npm run deploy-eo -- <EDGEONE_TOKEN>
```

> Token 可在 [EdgeOne 控制台 → 个人中心 → API Token](https://console.cloud.tencent.com/edgeone/pages) 获取。EdgeOne 暂不支持 D1，需要在控制台环境变量中配置 `DB_SOURCE=mysql` 或 `prisma` 并提供对应连接串。

### 6. Node.js / Docker 自托管部署（可选）

#### ① 直接使用 Node.js 运行

```bash
cp .env.example .env       # 编辑 .env 填入环境变量
npm run build-js           # 使用 webpack 打包到 dist/bundle.js
npm run deploy-js          # 启动服务（默认监听 3000 端口）
```

#### ② Docker Compose 一键部署（推荐）

```bash
docker compose up -d
```

> 默认用**你自己的代码**构建镜像（`build: .`）。请先编辑 [docker-compose.yml](docker-compose.yml) 填入环境变量。
> **变量写法**：`MAIL_KEYS` 与历史前缀 `OPLIST_MAIL_KEYS` 都识别（同名时以不带前缀的为准），
> 两种写法都可以继续用。

#### ③ 自行构建镜像

项目提供两种 Dockerfile 方案：

| 文件 | 基础镜像 | 适用场景 |
| :--- | :--- | :--- |
| [Dockerfile](Dockerfile) | `node:lts` (Debian) | **完整版**：内置 D1 (本地 SQLite 模拟) + cron 定时任务，开箱即用 |
| [Dockerfile-Lite](Dockerfile-Lite) | `node:lts-alpine` | **轻量版**：体积小，需配合外部 MySQL / Prisma 与外部定时器 |

```bash
# 构建完整版
docker build -t certhub:latest -f Dockerfile .

# 构建轻量版
docker build -t certhub:lite -f Dockerfile-Lite .

# 启动（请按实际情况补全 -e 环境变量）
docker run -d --name certhub -p 3000:3000 \
  -e MAIL_KEYS="" -e MAIL_SEND="" \
  -e DCV_AGENT="" -e DCV_EMAIL="" -e DCV_TOKEN="" -e DCV_ZONES="" \
  certhub:latest
```

---

## ⚙️ 配置说明

> 所有变量均通过 `wrangler.jsonc` 的 `vars` 段（Cloudflare Workers）、EdgeOne 控制台环境变量、或 `.env` 文件（Docker / Node.js）注入。**部分变量也可在「系统管理」→「全局配置」页面运行时动态修改**，运行时配置优先级 **高于** 环境变量。

### 1️⃣ 数据库配置（DB_*）

本项目支持 **三种数据源**，通过 `DB_SOURCE` 切换：

| 变量 | 必填 | 默认值 | 说明 |
| :--- | :--: | :--- | :--- |
| `DB_SOURCE` | ✅ | `d1` | 数据源类型：`d1` / `mysql` / `prisma` |
| `DB_CF` | △ | — | **Cloudflare D1 数据库绑定名**（`DB_SOURCE=d1` 时必填，在 `wrangler.jsonc` 的 `d1_databases[0].binding` 里配置；这是**代码里用的变量名**，通常不用改） |
| `DB_MYSQL_URL` | △ | — | **MySQL 完整连接串**（推荐），如 `mysql://user:pass@host:3306/db` |
| `DB_MYSQL_HOST` | △ | — | MySQL 主机（未提供 `DB_MYSQL_URL` 时必填） |
| `DB_MYSQL_PORT` | ❌ | `3306` | MySQL 端口 |
| `DB_MYSQL_USER` | △ | — | MySQL 用户名 |
| `DB_MYSQL_PASS` | △ | — | MySQL 密码 |
| `DB_MYSQL_NAME` | △ | — | MySQL 数据库名 |
| `DATABASE_URL` | △ | — | **Prisma 数据库连接串**（`DB_SOURCE=prisma` 时使用） |

> 📌 **D1 库名约定**：`database_name` 默认取成**和 Worker 同名**（默认都是 `cfworker-acme`），
> 这样在 Cloudflare 面板的 Workers / D1 两个列表里能一眼对上，不会出现"这个库是给哪个 Worker 用的"。
> - 想换个名字 → 改 `wrangler.jsonc` 的 `database_name`，或 Actions 里设变量 `D1_DATABASE_NAME`；
> - 想改成别的 Worker 名 → 只改 `NAME`，库名会跟着走（Actions 路径）；
> - ⚠️ **库名/ID 一旦定下来就不要改**：换了名字 wrangler 会去创建/使用另一个库，表现为"数据凭空没了"。
>   已有数据要保留时，最稳的是把 `database_id` 直接填进配置（或设变量 `D1_DATABASE_ID`），
>   而不是靠库名去猜——例如你之前用过旧名字 `DB_CF`，就把 `D1_DATABASE_NAME` 设成 `DB_CF` 继续用。

> 💡 Cloudflare Workers 环境强烈建议使用 `d1`；自托管 / Docker 环境推荐 `mysql` 或 `prisma`。

### 2️⃣ 邮件通知（MAIL_*）

| 变量 | 必填 | 说明 | 示例 / 获取 |
| :--- | :--: | :--- | :--- |
| `MAIL_KEYS` | ✅ | Resend API Key（用于发送邮件通知、邮箱验证、签发提醒等） | `re_wvRR+z5AqmL...` · [获取](https://resend.com/api-keys) |
| `MAIL_SEND` | ✅ | Resend 发件邮箱（必须为 Resend 已验证域名下的邮箱） | `noreply@example.com` |

### 3️⃣ 人机验证（AUTH_KEYS / SITE_KEYS）

用于登录、注册、申请证书等敏感操作的人机验证，支持 Cloudflare Turnstile / hCaptcha / reCAPTCHA。

| 变量 | 必填 | 说明 | 获取 |
| :--- | :--: | :--- | :--- |
| `AUTH_KEYS` | ❌ | 验证码 **Secret Key**（服务端校验密钥） | [Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) |
| `SITE_KEYS` | ❌ | 验证码 **Site Key**（前端展示密钥） | 同上 |

> 💡 **优先级**：「系统管理」页面运行时配置 > 环境变量 > 旧键 `CERT_CAPTCHA_SECRET_KEY` / `CERT_CAPTCHA_SITE_KEY`（兼容回退）。两个 Key 都为空时人机验证自动关闭。

### 4️⃣ DCV 自动验证代理（DCV_*，🌟强烈推荐）

> 配置 DCV 代理后，**只需设置一次 CNAME 记录** 即可永久自动续期，无需每次申请都手动添加 TXT 记录。

| 变量 | 必填 | 说明 | 获取 / 示例 |
| :--- | :--: | :--- | :--- |
| `DCV_AGENT` | ✅ | DCV 代理域名（**已托管在 Cloudflare 的根域名**） | `dcv.example.com` |
| `DCV_EMAIL` | ✅ | Cloudflare 账号邮箱（用 Global API Key 时必填；用 scoped Token 时可留空） | `user@example.com` |
| `DCV_TOKEN` | ✅ | **Global API Key 或 scoped API Token 都支持**（自动识别，见下） | [API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `DCV_ZONES` | ❌ | Zone ID，**可留空**。留空时按域名自动匹配；多个用逗号分隔 | [Cloudflare Dashboard](https://dash.cloudflare.com/) → 域名概览右侧 |

> 🔑 **`DCV_TOKEN` 两种凭证都能用**：程序按 token 形态自动选择鉴权头——
> 37 位十六进制视为 Global API Key（用 `X-Auth-Email` + `X-Auth-Key`），
> 其余（40 位 scoped Token）走 `Authorization: Bearer`。
> 早期版本只会发 `X-Auth-Key`，把 scoped Token 填进去会直接报
> `6003 Invalid request headers`；现已修复，推荐用 scoped Token：
> 权限只需 `Zone → DNS → Edit`，且可以限定到具体域名。
>
> 🌐 **多根域：`DCV_ZONES` 可留空。** 留空时程序调用 `GET /zones` 列出账号下所有
> Zone，按**最长后缀匹配**定位所属 Zone（`a.sub.example.com` 命中
> `sub.example.com` 而非 `example.com`），因此 `example.com`、`test.com`
> 等多个根域可同时托管，无需手工抄写 Zone ID。
> 自动匹配要求 Token 具备 `Zone → Zone → Read`；
> 不具备该权限时仍可显式填写 Zone ID（支持多个，逗号分隔）。
>
> 💡 `DCV_AGENT` 无需单独部署服务，它是自有域名下的一个子域，
> 用于存放 ACME 验证 TXT 记录（例如 `dcv.example.com`）。
>
> 🔁 **CNAME 由程序自动创建。** 申请 `dns-auto` 订单时，程序会在域名所属 Zone
> 中建立 `_acme-challenge.<域名>` → `DCV_AGENT` 的 CNAME（代理关闭），
> 验证记录由本 Worker 通过 CF API 自动增删，用户无需手工添加任何记录。
> 若该记录已存在则保持原样，不覆盖用户的手工配置。
> Token 需对该域名具备 `Zone → DNS → Edit` 权限；无权限时自动创建失败，
> 此时可在订单详情页按提示手工添加 CNAME。
>
> 🩺 **配置自检**：系统管理 → DCV 卡片 → 「检查 DCV 配置」会逐项验证
> Token 有效性、Zone 读取权限、`DCV_AGENT` 归属与 DNS 读取权限，
> 无需通过真实订单试错。

### 5️⃣ 自动续期（AUTO_RENEW_*）

> 申请页勾选「自动续期」的订单，会在到期前自动重新签发，无需人工干预。

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `AUTO_RENEW_ENABLED` | `true` | 总开关；设为 `false` 可整体停用自动续期 |
| `AUTO_RENEW_DAYS` | `30` | 距到期不足该天数时触发续期 |

> ⚙️ **工作原理**：cron 每 5 分钟扫描一次，命中窗口的订单被重置为 `flag=0`，
> 由状态机重新走完「建单 → 验证 → 签发」，成功后刷新到期时间。
>
> 📅 **到期时间取自证书真实的 `notAfter`**（解析 X.509 有效期），
> 不再假设「签发时间 + 90 天」——CA 的策略变化时提醒与续期窗口不会算错。
>
> ⚠️ **需要人工验证的订单不会被自动推进**：`dns-self` / `web-self` 仍会停在
> `flag=2` 等待人工处理。此时若已临近到期，系统会推送一条
> 「自动续期需要人工处理」的提醒，避免证书过期未被发现。
>
> 📥 **续期期间证书照常可下载**：下载接口不要求 `flag=5`，只要库中存在证书即返回，
> 因此各服务器在续期窗口内不会拉不到证书。


### 6️⃣ CA 厂商配置（XXX_*）

每个 CA 都遵循 **`XXX_useIt` / `XXX_keyMC` / `XXX_keyID` / `XXX_KeyTS`** 的命名规则：

| 前缀 | CA 厂商 | EAB 凭证获取 |
| :--- | :--- | :--- |
| `GTS_` | Google Trust Service | [Public CA Tutorial](https://cloud.google.com/certificate-manager/docs/public-ca-tutorial?hl=zh-cn) |
| `SSL_` | SSL.com ACME | [SSL.com Account](https://secure.ssl.com/account) |
| `ZRO_` | ZeroSSL ACME | [ZeroSSL Developer](https://app.zerossl.com/developer) |

| 字段后缀 | 含义 | 示例 |
| :--- | :--- | :--- |
| `XXX_useIt` | 是否启用该 CA（`true` 启用，`false` 关闭；留空时按凭据是否齐全判定） | `true` |
| `XXX_keyID` | EAB 账号 ID（External Account Binding Key ID） | `bfc7fb688d84` |
| `XXX_keyMC` | EAB-MAC 密钥（HMAC Key） | `2SfXncG3Akx...` |
| `XXX_KeyTS` | ACME 账号私钥（PEM 格式，需保留 `\n` 换行） | `-----BEGIN PRIVATE KEY-----\n...` |

> 🔀 **关闭的厂商不再出现在申请页**，后端也会拒绝以该 CA 下单，
> 避免绕过界面直接调用接口。留空时回退为「凭据齐全即启用」，
> 保证仅配置凭据而未改动开关的部署不受影响。

> 💡 **Let's Encrypt** 不需要 EAB，默认始终启用。但其在 Cloudflare Workers 上会出现 SSL 525 错误，需要使用 Nginx 反向代理（见下方[备注说明](#-备注说明)）。

### 7️⃣ 多服务器共用同一张证书

> 同一张证书供多台服务器使用时只签发一次，其余服务器定时拉取，避免各机器
> 分别申请得到多张不同的证书。

**第一步：签一张通配符证书**

申请 `*.example.com` + `example.com`，验证方式选「TXT 自动验证」。
`*.example.com` 覆盖全部一级子域，只需一条 `_acme-challenge.example.com` 的 CNAME，
与各子域是否已添加解析无关。

**第二步：每台服务器部署同步脚本**

使用 [`scripts/sync-cert.sh`](scripts/sync-cert.sh)：填好文件顶部的配置，
加入 dpanel「容器管理 → 计划任务」（执行容器留空，即在该容器内执行），
或写入宿主机 crontab：

```sh
0 3 * * * /root/sync-cert.sh >> /var/log/sync-cert.log 2>&1
```

脚本流程：拉取证书 → 校验证书与私钥是否配对 → 内容变化时原子替换 →
`nginx -s reload`。拉取失败时保留现有证书。

**第三步：停掉其他服务器上的重复申请**

各服务器自行申请的旧证书需要删除，否则仍会继续向 CA 申请。
顺序为先确认域名已切换到通配符证书且访问正常，再删除旧证书。

| 要点 | 说明 |
| :--- | :--- |
| 采用拉取而非推送 | dpanel 无长期 API Token（JWT 在服务重启后失效），推送需保存各机凭据并开放入站；拉取只需每台持一个只读 Token |
| 证书路径 | dpanel 容器内 `/dpanel/acme/<域名>_ecc/`，文件名为 `fullchain.cer` 与 `<域名>.key` |
| 首次准备 | 先用下载的 ZIP 在 dpanel「证书管理 → 手动上传」导入一次，生成目录与 `.conf` 元数据 |
| 证书尚未签发时 | 脚本拉取失败并保留现状，不修改已有证书 |


### 8️⃣ 完整变量速查表

<details>
<summary>📋 点击展开 / 收起 全部变量速查表</summary>

| 分类 | 变量名 | 必填 | 说明 |
| :--- | :--- | :--: | :--- |
| 数据库 | `DB_SOURCE` | ✅ | 数据源类型：`d1` / `mysql` / `prisma` |
| 数据库 | `DB_CF` | △ | Cloudflare D1 绑定（`d1` 模式必填） |
| 数据库 | `DB_MYSQL_URL` | △ | MySQL 完整连接串（`mysql` 模式二选一） |
| 数据库 | `DB_MYSQL_HOST` | △ | MySQL 主机 |
| 数据库 | `DB_MYSQL_PORT` | ❌ | MySQL 端口（默认 3306） |
| 数据库 | `DB_MYSQL_USER` | △ | MySQL 用户 |
| 数据库 | `DB_MYSQL_PASS` | △ | MySQL 密码 |
| 数据库 | `DB_MYSQL_NAME` | △ | MySQL 数据库名 |
| 数据库 | `DATABASE_URL` | △ | Prisma 连接串（`prisma` 模式使用） |
| 邮件 | `MAIL_KEYS` | ✅ | Resend API Key |
| 邮件 | `MAIL_SEND` | ✅ | Resend 发件邮箱 |
| 验证码 | `AUTH_KEYS` | ❌ | 人机验证 Secret Key |
| 验证码 | `SITE_KEYS` | ❌ | 人机验证 Site Key |
| DCV | `DCV_AGENT` | ✅ | DCV 代理根域名 |
| DCV | `DCV_EMAIL` | ✅ | Cloudflare 账号邮箱 |
| DCV | `DCV_TOKEN` | ✅ | Cloudflare API Key |
| DCV | `DCV_ZONES` | ❌ | Zone ID，可留空（留空时自动匹配）；多个用逗号分隔 |
| 自动续期 | `AUTO_RENEW_ENABLED` | ❌ | 自动续期总开关（默认 `true`） |
| 自动续期 | `AUTO_RENEW_DAYS` | ❌ | 提前多少天续期（默认 `30`） |
| 站点 | `MAIN_URLS` | ❌ | 站点主域名（Node.js / Docker 模式邮件链接拼接用） |
| CA · GTS | `GTS_useIt` / `GTS_keyMC` / `GTS_keyID` / `GTS_KeyTS` | ❌ | Google Trust Service |
| CA · SSL | `SSL_useIt` / `SSL_keyMC` / `SSL_keyID` / `SSL_KeyTS` | ❌ | SSL.com |
| CA · ZRO | `ZRO_useIt` / `ZRO_keyMC` / `ZRO_keyID` / `ZRO_KeyTS` | ❌ | ZeroSSL |

说明：✅ 必填　❌ 可选　△ 条件必填（依赖其它变量取值）

</details>

---

## 📝 备注说明

### Let's Encrypt 反向代理配置

`Let's Encrypt` 在 Cloudflare Worker 上会抛出 SSL 连接失败问题（525 错误）。本项目默认使用代理 `https://encrys.524228.xyz/directory`，你也可以使用 Nginx 自建：

```nginx
location ^~ /directory {
    proxy_pass https://acme-v02.api.letsencrypt.org/directory;
    sub_filter acme-v02.api.letsencrypt.org encrys.524228.xyz;
    sub_filter_types *;
    sub_filter_once off;
    proxy_set_header Host acme-v02.api.letsencrypt.org;
    proxy_set_header Accept-Encoding "";
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    add_header X-Cache $upstream_cache_status;
    add_header Cache-Control no-cache;
}

location /acme/ {
    proxy_pass https://acme-v02.api.letsencrypt.org/acme/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    add_header X-Cache $upstream_cache_status;
    add_header Cache-Control no-cache;
}
```

---

## ❓ 常见问题

<details>
<summary><b>Q：提交申请后状态停在「创建中 / 验证中」，要等多久？</b></summary>

申请接口只负责落库，ACME 交互在响应之后的后台任务里执行，因此提交后立即返回，
页面会轮询刷新状态（约 3 秒一次，最多 6 分钟）。

这样设计的原因：ACME 每次签名请求都要重新获取 nonce，单次 `newNonce` 在
ZeroSSL 上实测可达 8~32 秒。走到「待验证」需 3 轮串行签名请求
（`createOrder` → `getOrder` → `getAuthorizations`），按实测中位数约 30 秒，
正好撞上前端 30 秒请求超时（`timeout of 30000ms exceeded`），更长则触发
Cloudflare 网关 `524`（默认 125 秒读超时）。

后台任务本身只有 30 秒窗口，超时未完成的部分由 cron 续跑：
Cloudflare Workers 为每 5 分钟，Node.js / Docker 自托管为每分钟（容器内 crontab），
因此最坏情况等待分别约为 5 分钟和 1 分钟。轮询到上限后停止，点「刷新」可继续查看。
需要人工配置 DNS 的 `dns-self` / `web-self` 订单仍会停在 `flag=2`，不会自动推进。

</details>

<details>
<summary><b>Q：已经有 <code>acme.sh</code> 了，为什么还需要 CertHub？</b></summary>

1. **多机共享**：`acme.sh` 是单机证书申请脚本；CertHub 解决 **多服务器 / 内网共用同一证书** 的同步下发问题，可通过网页或 API 同步证书。
2. **永久 CNAME**：`acme.sh` 申请通配符证书时需要重复设置 TXT 记录；CertHub **只需设置一次 CNAME** 即可永久续期。
3. **零门槛**：如果你熟悉 `acme.sh` 且没有上述需求，使用 `acme.sh` 也完全够用。

</details>

<details>
<summary><b>Q：和宝塔 / 1Panel 的 SSL 证书申请功能有什么区别？</b></summary>

定位类似来此加密（<https://lcjm.cc/>），把申请验证过程移到了 **服务端 / Serverless 平台**，更方便 DCV 代理与多端同步。

</details>

<details>
<summary><b>Q：演示平台安全可靠吗？</b></summary>

演示平台 **不会主动泄漏** 您的密钥数据，但无法保证您的证书密钥 100% 安全。如对安全性有较高要求，**强烈建议使用自己的 Cloudflare / EdgeOne 账号私有化部署**。本项目完全开源，可审计。

</details>

<details>
<summary><b>Q：用「一键部署」按钮部署，Cloudflare 一直报“构建项目失败”怎么办？</b></summary>

老版本（v2.1 之前）是**必定失败**的，根因有三个，都在 v2.1 修掉了：

1. **前端依赖没装**：根 `package.json` 的 `build` 只是 `npm --prefix frontend run build`，
   而 Cloudflare Workers Builds 只会在**根目录**执行一次 `npm ci`，`frontend/node_modules` 始终是空的
   → 日志里会出现几百条 `TS2307: Cannot find module 'antd' / 'zustand' / 'dayjs'`。
   v2.1 改为 npm workspaces，`npm ci` 一次装完根 + 前端。
2. **TypeScript 6 弃用 `baseUrl`**：`frontend/tsconfig.json` 里的 `baseUrl` 会让新版 tsc 直接
   以 `TS5101` 中断构建。v2.1 去掉了 `baseUrl` 并改用相对路径映射。
3. **D1 占位符**：`wrangler.jsonc` 里 `database_id: "<database-id>"` 不是合法 UUID，`wrangler deploy` 必失败。
   v2.1 删掉了 `database_id`，由 wrangler 自动创建数据库。

如果你不能升级代码，至少把面板里的**构建命令**改成：

```bash
npm install --prefix frontend && npm run build
```

并把 `wrangler.jsonc` 的 `database_id` 换成真实 ID（`npx wrangler d1 create cfworker-acme` 会打印）。

</details>

---

## 💚 项目赞助

本项目 CDN 加速及安全防护由 **Tencent EdgeOne** 赞助：EdgeOne 提供长期有效的免费套餐，包含不限量的流量和请求，覆盖中国大陆节点，且无任何超额收费。

🔗 [亚洲最佳 CDN、边缘和安全解决方案 - Tencent EdgeOne](https://edgeone.ai/zh?from=github)

<p align="center">
  <img src="https://edgeone.ai/media/34fe3a45-492d-4ea4-ae5d-ea1087ca7b4b.png" alt="EdgeOne" width="400" />
</p>

---

## 🔗 引用与致谢

- [acmesh-official/acme.sh](https://github.com/acmesh-official/acme.sh) — A pure Unix shell script implementing ACME client protocol
- [publishlab/node-acme-client](https://github.com/publishlab/node-acme-client) — Simple and unopinionated ACME client for Node.js
- [Hono](https://hono.dev/) — Ultrafast web framework for the Edges
- [maillab/cloud-mail](https://github.com/maillab/cloud-mail) — GitHub Actions 自动部署 Cloudflare Workers 的流程（凭据校验 / 自动建 D1 / 部署后初始化）参考了它的实现

---

## 📄 License

本项目基于 [Apache License 2.0](LICENSE) 开源，欢迎贡献代码与提出建议！

<div align="center">

**如果这个项目对你有帮助，请点一颗 ⭐ Star 支持一下！**

</div>