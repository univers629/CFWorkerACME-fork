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

由于腾讯云EdgeOne Pages目前尚且不支持D1数据库，如果使用腾讯云EdgeOne Pages部署，需要使用外部数据库，参考变量部分

---

## 🆕 近期修复与升级（v2.1）

| 问题 | 现象 | 修复 |
| :--- | :--- | :--- |
| 前端依赖没被安装 | Cloudflare 构建日志里几百条 `TS2307: Cannot find module 'antd' / 'zustand' / 'dayjs'` | 根目录改为 npm workspaces，`npm install` 一次装完根 + `frontend/`，`npm run build` 相应改为 `npm run build --workspace cfworker-acme-frontend` |
| TypeScript 6 弃用 `baseUrl` | `frontend/tsconfig.json(28,5): error TS5101: Option 'baseUrl' is deprecated`，构建直接中断 | 去掉 `baseUrl`，`paths` 改为 `"./src/*"` 相对写法；根目录显式锁 `typescript@^5.9.3` |
| Workers Sites 已废弃 | `wrangler.jsonc` 用 `site.bucket` + 代码里 `__STATIC_CONTENT_MANIFEST`，需要额外的 KV 命名空间 | 升级为 Workers 静态资源（`assets` + `not_found_handling: single-page-application` + `run_worker_first` API 前缀），静态文件不再经过 Worker |
| D1 占位符导致部署失败 | `database_id: "<database-id>"` 不是合法 UUID，`wrangler deploy` 必失败 | 删除 `database_id`，交给 wrangler ≥4.45 的自动资源创建；已建库的用户把 ID 填回即可 |
| 定时任务空转 | `scheduled()` 只打日志，Cloudflare 上的订单永远不会自动推进/续期 | `scheduled()` 改为调用 `certs.Processing(env)`，并区分 `*/5` 频率 |
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
      "binding": "DB_CF",
      "database_name": "DB_CF"
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

> ✅ **D1 数据库不需要手动创建**：`wrangler.jsonc` 里只写了 `binding` 和 `database_name`，
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
> | `database_id ... is not a valid UUID` / `A D1 database with ID "<database-id>" was not found` | 配置里还是 `<database-id>` 占位符 | 删掉 `database_id` 让 wrangler 自动创建，或执行 `npx wrangler d1 create DB_CF` 后把真实 ID 填回 |
> | 部署成功但页面白屏、`/assets/*.js` 404 | 前端没构建，`public/` 里是仓库中过期的 `index.html` | 确认构建命令包含 `npm run build` |

#### ② 部署到 EdgeOne Pages

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
| `DB_CF` | △ | — | **Cloudflare D1 数据库绑定**（`DB_SOURCE=d1` 时必填，在 `wrangler.jsonc` 的 `d1_databases` 中配置） |
| `DB_MYSQL_URL` | △ | — | **MySQL 完整连接串**（推荐），如 `mysql://user:pass@host:3306/db` |
| `DB_MYSQL_HOST` | △ | — | MySQL 主机（未提供 `DB_MYSQL_URL` 时必填） |
| `DB_MYSQL_PORT` | ❌ | `3306` | MySQL 端口 |
| `DB_MYSQL_USER` | △ | — | MySQL 用户名 |
| `DB_MYSQL_PASS` | △ | — | MySQL 密码 |
| `DB_MYSQL_NAME` | △ | — | MySQL 数据库名 |
| `DATABASE_URL` | △ | — | **Prisma 数据库连接串**（`DB_SOURCE=prisma` 时使用） |

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
| `DCV_EMAIL` | ✅ | Cloudflare 账号邮箱 | `user@example.com` |
| `DCV_TOKEN` | ✅ | Cloudflare Global API Key 或具备 DNS 编辑权限的 Token | [API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `DCV_ZONES` | ✅ | `DCV_AGENT` 域名所属的 **Cloudflare Zone ID** | [Cloudflare Dashboard](https://dash.cloudflare.com/) → 域名概览右侧 |

### 5️⃣ CA 厂商配置（XXX_*）

每个 CA 都遵循 **`XXX_useIt` / `XXX_keyMC` / `XXX_keyID` / `XXX_KeyTS`** 的命名规则：

| 前缀 | CA 厂商 | EAB 凭证获取 |
| :--- | :--- | :--- |
| `GTS_` | Google Trust Service | [Public CA Tutorial](https://cloud.google.com/certificate-manager/docs/public-ca-tutorial?hl=zh-cn) |
| `SSL_` | SSL.com ACME | [SSL.com Account](https://secure.ssl.com/account) |
| `ZRO_` | ZeroSSL ACME | [ZeroSSL Developer](https://app.zerossl.com/developer) |

| 字段后缀 | 含义 | 示例 |
| :--- | :--- | :--- |
| `XXX_useIt` | 是否启用该 CA（`true` 启用；空字符串或留空表示禁用） | `true` |
| `XXX_keyID` | EAB 账号 ID（External Account Binding Key ID） | `bfc7fb688d84` |
| `XXX_keyMC` | EAB-MAC 密钥（HMAC Key） | `2SfXncG3Akx...` |
| `XXX_KeyTS` | ACME 账号私钥（PEM 格式，需保留 `\n` 换行） | `-----BEGIN PRIVATE KEY-----\n...` |

> 💡 **Let's Encrypt** 不需要 EAB，默认始终启用。但其在 Cloudflare Workers 上会出现 SSL 525 错误，需要使用 Nginx 反向代理（见下方[备注说明](#-备注说明)）。

### 6️⃣ 完整变量速查表

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
| DCV | `DCV_ZONES` | ✅ | Cloudflare Zone ID |
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

并把 `wrangler.jsonc` 的 `database_id` 换成真实 ID（`npx wrangler d1 create DB_CF` 会打印）。

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

---

## 📄 License

本项目基于 [Apache License 2.0](LICENSE) 开源，欢迎贡献代码与提出建议！

<div align="center">

**如果这个项目对你有帮助，请点一颗 ⭐ Star 支持一下！**

</div>