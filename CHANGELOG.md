# CHANGELOG

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- 新增 `funcaptcha` 模式，用于在受控测试页或 CTF toy app 中读取 `arkose_labs_token`
- `funcaptcha` 返回值补充 `page_url` 与 `page_title`，便于确认重定向后的真实落点

### Changed

- README API 文档现已同步说明 `funcaptcha` 的 lab-only 边界与调用示例

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
