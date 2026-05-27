# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 新增 `funcaptcha` 模式，用于在受控测试页或 CTF toy app 中读取 `arkose_labs_token`
- `funcaptcha` 返回值补充 `page_url` 与 `page_title`，便于确认重定向后的真实落点
- 新增 CloakBrowser 主浏览器路径，通过 `cloakbrowser/puppeteer` 启动 stealth Chromium binary
- 新增 CloakBrowser 相关配置：`CLOAKBROWSER_HEADLESS`、`CLOAKBROWSER_HUMANIZE`、`CLOAKBROWSER_STEALTH_ARGS`、`CLOAKBROWSER_FINGERPRINT_SEED`、`CLOAKBROWSER_TIMEZONE`、`CLOAKBROWSER_LOCALE`
- 新增仓库内 `iuam-rebrowser` provider，用显式 `rebrowser-puppeteer-core` / `chrome-launcher` / `ghost-cursor` / `xvfb` 组合处理需要点击的 IUAM managed challenge

### Changed

- `proxy` 请求参数现在统一为 `{"url", "username", "password"}` 形态，不再接受旧的 `hostname` / `port` 拆分格式
- `cloakbrowser` 依赖精确锁定为 `0.3.21`，使 Linux Docker 默认使用 Chromium `145.0.7632.159.9`，避免自动落到 `Chrome/146`
- `turnstile` 与 `funcaptcha` 保持 CloakBrowser 主线；`iuam` 模式复用 CloakBrowser Chromium binary 运行显式 `iuam-rebrowser` 路径
- 移除 `puppeteer-real-browser` 整包依赖，避免继续依赖黑盒 wrapper
- Docker Compose 默认通过 Xvfb 运行 headful CloakBrowser，并固定 fingerprint seed、timezone 与 locale
- Docker 构建阶段预下载 CloakBrowser binary，并将该层前移到源码复制之前以复用构建缓存，同时补充 emoji / 扩展字体包以降低 font/canvas 指纹异常
- Turnstile 增加自有 widget 点击循环与 `cf-turnstile-response` token 读取，用于替代旧版 `turnstile:true` 的隐式交互层
- README API 文档现已同步说明 `funcaptcha` 的 lab-only 边界与调用示例
- 默认日志级别现在聚焦摘要与异常，成功链路的 `request_start` / `browser_ready` 等细节下沉到 `LOG_LEVEL=debug`
- 启动生命周期日志改为区分 `server_listening` 与 `server_listen_failed`，避免端口占用时先报成功再报失败
- 请求摘要与拒绝日志重新补回脱敏后的 `target` 字段，保留站点上下文但不回打 query 噪声
- 域名规范化、目标校验与私网判断移动到 `utils/domain.js`，减少入口文件职责
- 请求拒绝日志与请求摘要元数据改为复用统一 helper，减少重复字段拼装
- Turnstile/IUAM 点击候选发现移动到 `utils/turnstile/clicker.js`，`turnstile` solver、IUAM provider 早期后台循环与 IUAM 点击兜底复用同一套候选逻辑
- IUAM strict 成功日志现在能通过 `background_click_strict_cookie_match` 区分 provider 早期点击后拿到的 `cf_clearance`
- IUAM endpoint 点击兜底现在会避开 provider 已经开始的后台点击循环，减少重复点击同一页面
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
