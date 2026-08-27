# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 新增 OpenAPI 3.1 JSON、ReDoc 说明页、就绪检查与核心组件自动测试
- 新增 `funcaptcha` 模式，用于在受控测试页或 CTF toy app 中读取 `arkose_labs_token`
- `funcaptcha` 返回值补充 `page_url` 与 `page_title`，便于确认重定向后的真实落点
- 新增 CloakBrowser 主浏览器路径，通过 `cloakbrowser/puppeteer` 启动 stealth Chromium binary
- 新增 CloakBrowser 相关配置：`CLOAKBROWSER_HEADLESS`、`CLOAKBROWSER_HUMANIZE`、`CLOAKBROWSER_STEALTH_ARGS`、`CLOAKBROWSER_TIMEZONE`、`CLOAKBROWSER_LOCALE`

### Changed

- `timeoutMs` 现在是请求级总预算，并统一限制为 `1000–300000ms`
- 请求可通过白名单字段 `browserPlatform` 选择 `windows`、`macos` 或 `linux` 指纹，默认使用 `macos`；`linux` 可用于容器原生指纹测试
- IUAM 点击由 endpoint 的单一等待循环调度，不再由 browser provider 抢跑
- IUAM 缓存改用临时文件加原子重命名落盘，并公开可观测状态
- `proxy` 请求参数现在统一为 `{"url", "username", "password"}` 形态，不再接受旧的 `hostname` / `port` 拆分格式
- `cloakbrowser` 依赖精确锁定为 `0.3.21`；Linux ARM64 Docker 构建使用 Chromium `145.0.7632.159.7`
- 所有模式统一使用 `cloakbrowser/puppeteer`，移除 IUAM 专用 Rebrowser provider 及其启动依赖
- 移除 `puppeteer-real-browser` 整包依赖，避免继续依赖黑盒 wrapper
- Docker Compose 默认通过 Xvfb 运行 headful CloakBrowser；timezone 与 locale 默认留空，需按代理出口显式设置
- Docker 构建阶段预下载 CloakBrowser binary，并将该层前移到源码复制之前以复用构建缓存，同时补充 emoji / 扩展字体包以降低 font/canvas 指纹异常
- Turnstile 增加自有 widget 点击循环与 `cf-turnstile-response` token 读取，用于替代旧版 `turnstile:true` 的隐式交互层
- README API 文档现已同步说明 `funcaptcha` 的 lab-only 边界与调用示例
- 默认日志级别现在聚焦摘要与异常，成功链路的 `request_start` / `browser_ready` 等细节下沉到 `LOG_LEVEL=debug`
- 启动生命周期日志改为区分 `server_listening` 与 `server_listen_failed`，避免端口占用时先报成功再报失败
- 请求摘要与拒绝日志重新补回脱敏后的 `target` 字段，保留站点上下文但不回打 query 噪声
- 域名规范化、目标校验与私网判断移动到 `utils/domain.js`，减少入口文件职责
- 请求拒绝日志与请求摘要元数据改为复用统一 helper，减少重复字段拼装
- Turnstile/IUAM 点击候选发现统一到 `utils/turnstile/clicker.js`
- IUAM 恢复 strict JSON response clearance 与 cookie jar 一致性校验；点击只推进挑战，不再把随机过渡 cookie 作为结果
- `request_complete` 成功日志补充 `proxy_enabled`，便于排查代理链路
- 环境变量收口为 `AUTH_TOKEN`、`BROWSER_LIMIT`、`REQUEST_TIMEOUT_MS`、`BROWSER_CLOSE_TIMEOUT_MS`、`SHUTDOWN_TIMEOUT_MS`，不再读取旧的 camelCase / `timeOut` 变量
- 所有运行时环境变量读取统一通过空字符串过滤，避免空值覆盖默认配置
- `SHUTDOWN_TIMEOUT_MS` 现在独立于请求超时，不再与旧 `timeOut` 变量隐式耦合
- IUAM 执行增加外层超时保护，避免极端页面操作挂起时占住并发信号量
- `funcaptcha` 现在区分 `funcaptcha_page_load` 与 `funcaptcha_wait_token` 两类超时，相比 `browser_connect` 更便于定位
- 浏览器关闭阶段新增独立超时与 `browser_close_failed` 告警，避免收尾反向拖长请求
- `funcaptcha_wait_token` 超时现在会尽量带上页面快照，失败日志也会补充 `proxy_enabled` 便于排查代理链路
- 当页面实际渲染的是 reCAPTCHA 而不是 `arkose_labs_token` 时，`funcaptcha` 会快速返回 `funcaptcha_recaptcha_present`，不再空等到超时
- `sleep` helper 统一到 `utils/async.js`
- `cacheStore.stop()` 增加幂等保护

### Fixed

- 修复 CloakBrowser 主路径下 `https://linux.do` 这类需要手动点击的 IUAM managed challenge 无法自动通过的问题。

## [1.0.0] - 2026-03-25

### Added

- `iuam` 与 `turnstile` 两种处理模式
- `GET /health` 健康检查接口与 Docker Compose healthcheck
- `ALLOW_PRIVATE_NETWORK_TARGETS` 配置项，用于控制是否允许私网字面量目标

### Changed

- `domain` 与 `proxy` 请求参数现在在入口阶段做显式校验
- IUAM 缓存键对 `domain` 做轻量规范化，减少同站不同写法导致的重复缓存
- 优雅退出时显式刷写缓存，并让关闭超时对齐请求超时上限
- Docker 默认镜像、容器、Compose 项目与网络命名统一为 `cf-bypass*`
- Docker healthcheck 命令已修正，不再出现服务可用但容器误报 `unhealthy`

### Internal

- IUAM 采用严格链路优先、点击兜底的处理流程
- 日志采用结构化输出，并补充请求链路排障字段
