# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 新增 `funcaptcha` 模式，用于在受控测试页或 CTF toy app 中读取 `arkose_labs_token`
- `funcaptcha` 返回值补充 `page_url` 与 `page_title`，便于确认重定向后的真实落点
- 新增 CloakBrowser 主浏览器路径，通过 `cloakbrowser/puppeteer` 启动 stealth Chromium binary
- 新增 CloakBrowser 相关配置：`CLOAKBROWSER_HEADLESS`、`CLOAKBROWSER_HUMANIZE`、`CLOAKBROWSER_STEALTH_ARGS`、`CLOAKBROWSER_FINGERPRINT_SEED`、`CLOAKBROWSER_TIMEZONE`、`CLOAKBROWSER_LOCALE`

### Changed

- `proxy` 请求参数现在统一为 `{"url", "username", "password"}` 形态，不再接受旧的 `hostname` / `port` 拆分格式
- 浏览器主线收敛为 CloakBrowser-only，移除 `puppeteer-real-browser` 依赖与系统 Chromium 143 回退路径
- Docker Compose 默认通过 Xvfb 运行 headful CloakBrowser，并固定 fingerprint seed、timezone 与 locale
- Docker 构建阶段预下载 CloakBrowser binary，并将该层前移到源码复制之前以复用构建缓存，同时补充 emoji / 扩展字体包以降低 font/canvas 指纹异常
- Turnstile 增加自有 widget 点击循环与 `cf-turnstile-response` token 读取，用于替代旧版 `turnstile:true` 的隐式交互层
- README API 文档现已同步说明 `funcaptcha` 的 lab-only 边界与调用示例
- 默认日志级别现在聚焦摘要与异常，成功链路的 `request_start` / `browser_ready` 等细节下沉到 `LOG_LEVEL=debug`
- 启动生命周期日志改为区分 `server_listening` 与 `server_listen_failed`，避免端口占用时先报成功再报失败
- 请求摘要与拒绝日志重新补回脱敏后的 `target` 字段，保留站点上下文但不回打 query 噪声
- `funcaptcha` 现在区分 `funcaptcha_page_load` 与 `funcaptcha_wait_token` 两类超时，相比 `browser_connect` 更便于定位
- 浏览器关闭阶段新增独立超时与 `browser_close_failed` 告警，避免收尾反向拖长请求
- `funcaptcha_wait_token` 超时现在会尽量带上页面快照，失败日志也会补充 `proxy_enabled` 便于排查代理链路
- 当页面实际渲染的是 reCAPTCHA 而不是 `arkose_labs_token` 时，`funcaptcha` 会快速返回 `funcaptcha_recaptcha_present`，不再空等到超时

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
