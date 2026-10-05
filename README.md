# CF Bypass

> 当前版本：`v1.0.0`（当前工作树包含未发布的 `funcaptcha` lab 模式）

一个基于 Node.js、CloakBrowser Chromium 与 IUAM 兼容浏览器路径的 Cloudflare IUAM / Turnstile / lab-only FunCaptcha 处理服务，用于在授权测试或受控环境中获取 `cf_clearance`、Turnstile token，或受控页面中的 `arkose_labs_token`。项目目标是保持接口简单、部署直接、日志可排障。

## 功能特性

- 支持 `iuam`、`turnstile` 与 `funcaptcha` 三种模式
- 支持对象形式的 HTTP / HTTPS 代理，并兼容部分 `socks5://` 传输场景
- IUAM 请求支持缓存，并通过 CloakBrowser 与共享 Turnstile clicker 处理需要点击的 managed challenge
- `funcaptcha` 模式支持打开受控页面并读取 `arkose_labs_token`
- `turnstile` 与 `funcaptcha` 使用 `cloakbrowser/puppeteer` 启动 CloakBrowser stealth Chromium binary
- 提供结构化日志与 `GET /health` 健康检查
- 提供 `GET /ready` 就绪检查、`GET /openapi.json` OpenAPI 3.1 文档与 `GET /docs` 在线说明页
- 提供 Docker Compose 部署配置

## 快速开始

### 本地运行

```bash
npm install
npm start
```

开发模式：

```bash
npm run dev
```

### Docker Compose

```bash
docker compose up --build -d
```

默认命名：

- 镜像：`cf-bypass:latest`
- 容器：`cf-bypass`
- Compose 项目：`cf-bypass`
- 默认网络：`cf-bypass_default`

## 环境变量

| 变量名                          | 默认值          | 描述                                                         |
| ------------------------------- | --------------- | ------------------------------------------------------------ |
| `PORT`                          | `8080`          | 服务监听端口                                                 |
| `HOST_PORT`                     | `8080`          | Docker Compose 宿主机映射端口，不影响容器内 `PORT`           |
| `AUTH_TOKEN`                    | `null`          | 可选的接口认证 Token                                         |
| `BROWSER_LIMIT`                 | `20`            | 最大浏览器并发数；Docker Compose 默认设为 `3`                |
| `BROWSER_PLATFORM`              | `macos`         | 默认浏览器指纹平台；可用 `linux`、`macos`、`windows` 做 A/B 测试；当前 Linux 容器不建议使用 `windows` |
| `REQUEST_TIMEOUT_MS`            | `60000`         | 全局请求超时（毫秒）；Docker Compose 默认设为 `90000`         |
| `BROWSER_CLOSE_TIMEOUT_MS`      | `5000`          | 单次请求结束后等待浏览器关闭的最长时间                       |
| `SHUTDOWN_TIMEOUT_MS`           | `60000`         | 服务优雅退出总超时，独立于请求超时                           |
| `LOG_LEVEL`                     | `info`          | 日志级别：`debug` / `info` / `warn` / `error`                |
| `LOG_TIMEZONE`                  | `Asia/Shanghai` | 日志时区（IANA）                                             |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `true`          | 是否允许 `localhost`、私网、回环、链路本地字面量地址作为目标 |
| `CLOAKBROWSER_HEADLESS`         | `false`         | CloakBrowser 是否使用 headless 模式；Docker Compose 通过 Xvfb 默认使用 headful |
| `CLOAKBROWSER_HUMANIZE`         | `true`          | CloakBrowser 是否启用人类化鼠标/键盘/滚动行为                |
| `CLOAKBROWSER_STEALTH_ARGS`     | `true`          | CloakBrowser 是否使用默认 stealth 参数                       |
| `CLOAKBROWSER_TIMEZONE`         | `null`          | 可选 IANA 时区，例如 `America/New_York`                      |
| `CLOAKBROWSER_LOCALE`           | `null`          | 可选 BCP 47 locale，例如 `en-US`                             |
| `CLOAKBROWSER_AUTO_UPDATE`      | `false`         | Docker 镜像默认禁用 CloakBrowser 自动更新检查，避免版本漂移  |
| `CLOAKBROWSER_CACHE_DIR`        | `/app/.cloakbrowser` | Docker 镜像内 CloakBrowser binary 缓存目录              |
| `CLOAKBROWSER_BINARY_PATH`      | `null`          | 可选指定本地 CloakBrowser binary；设置后会跳过默认版本映射   |

日志级别说明：

- `info`（默认）：保留 `server_*`、`request_complete`、`handler_reject`、`handler_error` 这类摘要与异常日志
- `debug`：额外输出 `request_start`、`browser_ready`、`iuam_clearance_update_waiting` 等排障细节
- logger 会自动省略 `null` / `undefined` 字段，避免成功日志被空值刷屏
- 摘要日志中的 `target` 会保留协议、主机与路径，但默认省略 query / hash，兼顾定位与降噪

浏览器运行时说明：

- 所有模式统一使用 `cloakbrowser/puppeteer`
- IUAM 自动等待页面实际的挑战流程完成，统一从浏览器上下文读取目标域名的 `cf_clearance`，返回后关闭浏览器；点击只推进挑战。
- 当前 `cloakbrowser` 依赖锁定为 `0.5.12`，要求 Node.js >= 20；未配置授权密钥时，包内默认 Linux ARM64 binary 为 Chromium `146.0.7680.177.3`，macOS ARM64 为 `145.0.7632.109.2`。实际运行版本以 `npx cloakbrowser info` 为准
- Docker Compose 使用 `xvfb-run -a npm start` 启动 headful CloakBrowser，以贴近真实桌面浏览器环境
- 如需后续切换到其他 CloakBrowser binary，可通过 `CLOAKBROWSER_BINARY_PATH=/app/.cloakbrowser/chromium-<version>/chrome` 显式指定；该路径必须在容器内真实存在
- CloakBrowser binary 受其独立 Binary License 约束；内部授权测试可用，若作为第三方浏览器服务提供需先确认 OEM/SaaS 授权

IUAM clearance 自动获取要求：

- 从当前浏览器上下文存储读取 Cookie，核对目标域名、路径及分区，返回原始值和同一浏览器的 UA。
- 目标主文档必须同源、状态正常、没有 `cf-mitigated: challenge`，页面不再显示挑战。
- 目标文档解析完成（DOMContentLoaded）、挑战解除后，若观察到 Precursor/JSD 检测，则等待检测 POST 完整结束并确认浏览器已应用对应 Cookie。普通资源不参与检测判断，脚本下载完成也不等于检测完成。
- 所有站点使用同一个读取入口，无需调用方选择模式；不按域名或响应是否 JSON 分类，也不要求 Cookie 必须再次变化。
- 已实测 linux.do 正常页面加载 `/cdn-cgi/challenge-platform/scripts/precursor/main.js`，随后异步 POST 更新 Cookie；Shodan 本次观察没有后续检测。此结论描述当前行为，不是永久域名规则。
- 获取匹配的 Cookie 后读取对应 UA，重新检查页面通过状态，再确认页面与 Cookie 未变化并自动返回、关闭浏览器。无需手动关闭窗口或按回车。
- 此路径不写入缓存，避免复用先前的 Cookie。
- 总预算耗尽时仍返回 504，`detail.phase` / `detail.reason` 保留具体原因：`iuam_wait_clearance` / `cookie_not_issued` 表示未观察到签发，`iuam_wait_challenge` 表示仍在挑战，`iuam_target_blocked` 表示目标 HTTP 错误，`iuam_wait_detection` 表示已识别检测未完成或失败。页面正常但没有 Cookie 不算求解成功。
- 当前自动等待覆盖已观察的 Precursor/JSD 流程；未知检测不能仅凭路径相似认定已兼容。返回的是浏览器当时的快照，不保证 Cookie 不再轮换或其他接口、客户端可用。

Turnstile 的结果是 `token`，不是 `cf_clearance`。当前接口在目标 URL 上使用合成 widget 页面；返回 Token 只说明该流程产生了 Token，不代表原站业务请求已通过服务端验证，也不保证签发 pre-clearance Cookie。

Docker/CloakBrowser 排障要点：

- `browserPlatform` 是请求级覆盖项，会优先于 `BROWSER_PLATFORM`；测试脚本若显式传入平台，会覆盖 Compose 默认值。
- Docker 的 binary 运行平台仍是 `linux-arm64`，即使 `browserPlatform` 设置为 `macos`；两者分别表示运行环境和浏览器指纹平台。
- 当前包内默认 Linux ARM64 Chromium 为 `146.0.7680.177.3`；升级 `cloakbrowser` 或配置授权密钥可能改变各平台 binary 版本，重建镜像后应执行 `npx cloakbrowser info` 核对。
- Linux 容器没有完整 Windows 字体集，`windows` 指纹可能导致 clearance 获取失败或后续 403，不建议作为默认平台。
- `CLOAKBROWSER_TIMEZONE` / `CLOAKBROWSER_LOCALE` 应与代理出口所在地匹配；不确定时保持为空，不要固定套用纽约时区。
- 若本机 `uv run cf_test.py` 因 `/Users/leishao/.cache/uv` 权限失败，可使用 `python3 cf_test.py`，或为 uv 指定可写缓存目录。

## API

### `POST /cloudflare`

请求体示例：

```json
{
  "mode": "iuam",
  "domain": "https://linux.do"
}
```

参数说明：

- `mode`：必填，`iuam`、`turnstile` 或 `funcaptcha`
- `domain`：必填，必须是合法的 `http://` 或 `https://` URL，且不能包含用户名/密码
- `siteKey`：`turnstile` 模式必填
- `timeoutMs`：可选，整数 `1000–300000`；表示从服务收到请求开始计算的总预算，优先于全局 `REQUEST_TIMEOUT_MS`
- `cache`：保留兼容；当前所有请求均不读取或写入缓存
- `browserPlatform`：可选，浏览器指纹平台；仅允许 `windows`、`macos`、`linux`，默认 `macos`。当前 Linux 容器缺少完整 Windows 字体集，不建议使用 `windows`；`linux` 可用于容器原生指纹测试
- `debugArtifacts`：可选，仅建议排障时设为 `true`；`turnstile` 失败时会输出页面诊断工件路径
- `proxy`：可选，代理对象格式如下

Turnstile 超时排障说明：

- 默认会在失败日志与错误 detail 中记录 `apiScriptRequested`、`apiScriptLoaded`、`apiScriptStatus`、`turnstileStatusCounts`、`turnstileNonOkResponses`、`turnstileIframeCount`、`consoleErrorCount`、`currentUrl`、`pageTitle`
- Turnstile 会循环检测并点击 `cf-turnstile-response` 父节点、Turnstile iframe、widget 容器及典型 300px challenge 区域，替代旧版外部 wrapper 的后台点击行为
- token 读取会同时检查自定义 `cf-response` 与 Cloudflare 自带的 `cf-turnstile-response`
- 当请求体设置 `"debugArtifacts": true` 时，失败会写入 `summary.json`、`html-summary.txt` 与 `screenshot.png`
- Docker 容器内默认工件目录是 `/tmp/cf-bypass-artifacts`，可通过 `DEBUG_ARTIFACT_DIR` 覆盖
- `turnstile_wait_token` 表示页面和浏览器已运行，但在超时时间内没有收到 Turnstile callback token

`funcaptcha` 超时说明：

- 若页面加载超时，日志与错误会标记为 `funcaptcha_page_load`
- 若页面直接渲染出 reCAPTCHA 而非 `arkose_labs_token`，会快速返回 `422`，并标记为 `funcaptcha_recaptcha_present`
- 若页面已打开但 `arkose_labs_token` 一直未出现或为空，日志与错误会标记为 `funcaptcha_wait_token`
- `funcaptcha_wait_token` 的错误 detail 会尽量附带当前页面快照，例如 `currentUrl`、`pageTitle`、`hasArkoseForm`、`tokenInputPresent`
- 请求结束后的浏览器关闭阶段受 `BROWSER_CLOSE_TIMEOUT_MS` 限制；即使关闭卡住，也不会继续无限拖长主请求

```json
{
  "url": "http://proxy.example.com:8080",
  "username": "optional-user",
  "password": "optional-pass"
}
```

代理约束：

- `url` 必须是合法的代理 URL，且必须显式包含协议与端口
- 当前支持的协议是 `http://`、`https://`、`socks4://`、`socks5://`
- `url` 不能内嵌用户名密码；若需要认证，请使用独立的 `username` / `password`
- 若提供认证信息，`username` 和 `password` 必须同时提供
- Chromium 对 SOCKS5 用户名密码认证的兼容性通常不如 HTTP / HTTPS 代理稳定

IUAM 每次新建浏览器会话，不读取或写入 clearance 缓存。请求中的 `cache` 字段保留兼容，当前不影响获取流程。

```json
{
  "cf_clearance": "xxx",
  "user_agent": "Mozilla/5.0...",
  "elapsed_time": 3.05,
  "cached": false
}
```

Turnstile 返回示例：

```json
{
  "token": "xxx",
  "user_agent": "Mozilla/5.0...",
  "elapsed_time": 3.05,
  "cached": false
}
```

FunCaptcha 返回示例：

```json
{
  "token": "78818a19367328485.0208258002|r=lab|pk=LOCAL-ARKOSE-KEY",
  "page_url": "https://toy-app.local/-/trial_registrations/new",
  "page_title": "Toy Registration",
  "user_agent": "Mozilla/5.0...",
  "elapsed_time": 1.42,
  "cached": false
}
```

错误返回示例：

```json
{
  "code": 504,
  "message": "Turnstile timeout after 60000ms",
  "detail": {
    "timeoutMs": 60000,
    "label": "Turnstile"
  }
}
```

### `GET /health`

用于存活探测与 Docker healthcheck。

响应示例：

```json
{
  "status": "ok",
  "uptime": 123.45,
  "concurrency": { "limit": 3, "inUse": 1, "available": 2 }
}
```

### 服务说明与就绪检查

- `GET /ready`：检查服务是否未进入退出流程，并返回并发状态；不依赖旧缓存文件
- `GET /openapi.json`：返回 OpenAPI 3.1 JSON，可直接导入 Postman、Insomnia 或代码生成工具
- `GET /docs`：使用 ReDoc 展示交互式接口说明；页面脚本来自 ReDoc CDN，离线环境请直接使用 `/openapi.json`

## 调用示例

IUAM：

```bash
curl -sS -X POST 'http://127.0.0.1:8080/cloudflare' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"https://linux.do","mode":"iuam","cache":false}'
```

Turnstile：

```bash
curl -sS -X POST 'http://127.0.0.1:8080/cloudflare' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"https://example.com","siteKey":"<your-site-key>","mode":"turnstile"}'
```

Turnstile debug：

```bash
curl -sS -X POST 'http://127.0.0.1:8080/cloudflare' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"https://example.com","siteKey":"<your-site-key>","mode":"turnstile","debugArtifacts":true}'
```

FunCaptcha：

```bash
curl -sS -X POST 'http://127.0.0.1:8080/cloudflare' \
  -H 'Content-Type: application/json' \
  -d '{"domain":"https://toy-app.local/-/trial_registrations/new","mode":"funcaptcha"}'
```

`funcaptcha` 说明：

- 该模式面向受控测试页或 CTF toy app，默认等待页面中的 `input[name="arkose_labs_token"]` 出现非空值
- 当前实现不会注入 Arkose 页面，也不会尝试求解真实站点挑战；它只读取页面中最终已经写入 DOM 的 token

## 项目结构

```text
index.js
config/
endpoints/
utils/
docker-compose.yml
Dockerfile
```

## 致谢

- [cf-bypass-fast](https://github.com/AkaneSakuramori/cf-bypass-fast)

## 说明

本项目仅供授权测试、学习与研究使用。请遵守目标站点规则与适用法律法规。
