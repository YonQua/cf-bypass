# CF Bypass

> 当前版本：`v1.0.0`（当前工作树包含未发布的 `funcaptcha` lab 模式）

一个基于 Node.js 与 Chromium 的 Cloudflare IUAM / Turnstile / lab-only FunCaptcha 处理服务，用于在授权测试或受控环境中获取 `cf_clearance`、Turnstile token，或受控页面中的 `arkose_labs_token`。项目目标是保持接口简单、部署直接、日志可排障。

## 功能特性

- 支持 `iuam`、`turnstile` 与 `funcaptcha` 三种模式
- 支持对象形式的 HTTP / HTTPS 代理，并兼容部分 `socks5://` 传输场景
- IUAM 请求支持缓存、严格链路优先与点击兜底
- `funcaptcha` 模式支持打开受控页面并读取 `arkose_labs_token`
- 提供结构化日志与 `GET /health` 健康检查
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
| `authToken`                     | `null`          | 可选的接口认证 Token                                         |
| `browserLimit`                  | `20`            | 最大浏览器并发数                                             |
| `timeOut`                       | `60000`         | 全局请求超时（毫秒）                                         |
| `browserCloseTimeoutMs`         | `5000`          | 单次请求结束后等待浏览器关闭的最长时间，避免收尾拖长响应     |
| `LOG_LEVEL`                     | `info`          | 日志级别：`debug` / `info` / `warn` / `error`                |
| `LOG_TIMEZONE`                  | `Asia/Shanghai` | 日志时区（IANA）                                             |
| `ALLOW_PRIVATE_NETWORK_TARGETS` | `true`          | 是否允许 `localhost`、私网、回环、链路本地字面量地址作为目标 |

日志级别说明：

- `info`（默认）：保留 `server_*`、`request_complete`、`handler_reject`、`handler_error` 这类摘要与异常日志
- `debug`：额外输出 `request_start`、`browser_ready`、`cache_purge`、`iuam_click_mode_enabled` 等排障细节
- logger 会自动省略 `null` / `undefined` 字段，避免成功日志被空值刷屏
- 摘要日志中的 `target` 会保留协议、主机与路径，但默认省略 query / hash，兼顾定位与降噪

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
- `timeoutMs`：可选，本次请求超时，优先于全局 `timeOut`
- `cache`：可选，仅对 `iuam` 生效；设为 `false` 时跳过缓存
- `proxy`：可选，代理对象格式如下

`funcaptcha` 超时说明：

- 若页面加载超时，日志与错误会标记为 `funcaptcha_page_load`
- 若页面直接渲染出 reCAPTCHA 而非 `arkose_labs_token`，会快速返回 `422`，并标记为 `funcaptcha_recaptcha_present`
- 若页面已打开但 `arkose_labs_token` 一直未出现或为空，日志与错误会标记为 `funcaptcha_wait_token`
- `funcaptcha_wait_token` 的错误 detail 会尽量附带当前页面快照，例如 `currentUrl`、`pageTitle`、`hasArkoseForm`、`tokenInputPresent`
- 请求结束后的浏览器关闭阶段受 `browserCloseTimeoutMs` 限制；即使关闭卡住，也不会继续无限拖长主请求

```json
{
  "hostname": "http://proxy.example.com",
  "port": 8080,
  "username": "optional-user",
  "password": "optional-pass"
}
```

代理约束：

- `hostname` 必须是非空字符串，建议带协议前缀，如 `http://`、`https://`、`socks5://`
- `port` 必须是正整数
- 若提供认证信息，`username` 和 `password` 必须同时提供
- Chromium 对 SOCKS5 用户名密码认证的兼容性通常不如 HTTP / HTTPS 代理稳定

IUAM 缓存说明：

- 缓存键基于轻量规范化后的 `domain` 与 `proxy`
- 规范化仅用于缓存键：会统一协议/主机大小写、去默认端口、忽略 URL 片段，并把裸域与根路径 `/` 视为同义
- 不会改动真实请求 URL

IUAM 返回示例：

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
  "uptime": 123.45
}
```

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
