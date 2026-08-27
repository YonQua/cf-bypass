const modeSchema = {
  type: 'string',
  enum: ['iuam', 'turnstile', 'funcaptcha'],
}

const proxySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: '包含显式端口的 http、https、socks4 或 socks5 代理 URL。',
      example: 'http://proxy.example.com:8080',
    },
    username: { type: 'string', minLength: 1 },
    password: { type: 'string', minLength: 1, format: 'password' },
  },
}

const errorSchema = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: { type: 'integer', example: 504 },
    message: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
    cached: { type: 'boolean', const: false },
  },
}

const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'CF Bypass API',
    version: '1.0.0',
    description:
      '面向授权测试和受控环境的 Cloudflare IUAM、Turnstile 与 lab-only FunCaptcha 服务。',
  },
  servers: [{ url: '/', description: '当前服务' }],
  tags: [
    { name: 'Solver', description: '浏览器挑战处理' },
    { name: 'Service', description: '服务状态与说明' },
  ],
  paths: {
    '/cloudflare': {
      post: {
        tags: ['Solver'],
        summary: '执行指定挑战模式',
        description:
          '`timeoutMs` 是从服务接收请求开始计算的总预算。`siteKey` 仅 Turnstile 必填；缓存仅 IUAM 生效。',
        operationId: 'solveChallenge',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SolveRequest' },
              examples: {
                iuam: { value: { mode: 'iuam', domain: 'https://example.com', cache: true } },
                turnstile: {
                  value: {
                    mode: 'turnstile',
                    domain: 'https://example.com',
                    siteKey: '1x00000000000000000000AA',
                  },
                },
                funcaptcha: {
                  value: { mode: 'funcaptcha', domain: 'https://toy-app.local/register' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: '成功',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/IuamResponse' },
                    { $ref: '#/components/schemas/TokenResponse' },
                  ],
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          422: { $ref: '#/components/responses/Unprocessable' },
          429: { $ref: '#/components/responses/TooManyRequests' },
          500: { $ref: '#/components/responses/InternalError' },
          504: { $ref: '#/components/responses/Timeout' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Service'],
        summary: '存活状态',
        operationId: 'getHealth',
        responses: {
          200: {
            description: '服务运行中',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
          503: { description: '服务正在退出' },
        },
      },
    },
    '/ready': {
      get: {
        tags: ['Service'],
        summary: '就绪状态',
        operationId: 'getReadiness',
        responses: {
          200: { description: '依赖的本地状态已就绪' },
          503: { description: '缓存加载失败或服务正在退出' },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['Service'],
        summary: 'OpenAPI 3.1 文档',
        operationId: 'getOpenApiDocument',
        responses: { 200: { description: 'OpenAPI JSON' } },
      },
    },
    '/docs': {
      get: {
        tags: ['Service'],
        summary: 'ReDoc 接口说明页',
        operationId: 'getApiDocs',
        responses: { 200: { description: 'HTML 说明页' } },
      },
    },
  },
  components: {
    schemas: {
      Mode: modeSchema,
      Proxy: proxySchema,
      SolveRequest: {
        type: 'object',
        additionalProperties: true,
        required: ['mode', 'domain'],
        properties: {
          mode: { $ref: '#/components/schemas/Mode' },
          domain: { type: 'string', format: 'uri', pattern: '^https?://' },
          siteKey: { type: 'string', minLength: 1 },
          authToken: { type: 'string', format: 'password' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 },
          cache: { type: 'boolean', default: true },
          browserPlatform: {
            type: 'string',
            enum: ['windows', 'macos', 'linux'],
            default: 'macos',
            description: '浏览器指纹平台。服务端仅转换为受控的 fingerprint-platform 参数。当前 Linux 容器缺少完整 Windows 字体集，不建议使用 windows；macos 可用于与本机运行结果对齐。',
          },
          debugArtifacts: { type: 'boolean', default: false },
          proxy: { $ref: '#/components/schemas/Proxy' },
        },
      },
      IuamResponse: {
        type: 'object',
        required: ['cf_clearance', 'cached'],
        properties: {
          cf_clearance: { type: 'string' },
          user_agent: { type: ['string', 'null'] },
          elapsed_time: { type: 'number' },
          cached: { type: 'boolean' },
        },
      },
      TokenResponse: {
        type: 'object',
        required: ['token', 'cached'],
        properties: {
          token: { type: 'string' },
          page_url: { type: 'string', format: 'uri' },
          page_title: { type: ['string', 'null'] },
          user_agent: { type: ['string', 'null'] },
          elapsed_time: { type: 'number' },
          cached: { type: 'boolean', const: false },
        },
      },
      Error: errorSchema,
      Concurrency: {
        type: 'object',
        required: ['limit', 'inUse', 'available'],
        properties: {
          limit: { type: 'integer' },
          inUse: { type: 'integer' },
          available: { type: 'integer' },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'uptime', 'concurrency'],
        properties: {
          status: { type: 'string', enum: ['ok', 'shutting_down'] },
          uptime: { type: 'number' },
          concurrency: { $ref: '#/components/schemas/Concurrency' },
        },
      },
    },
    responses: Object.fromEntries(
      [
        ['BadRequest', 400, '请求参数无效'],
        ['Unauthorized', 401, '认证失败'],
        ['Unprocessable', 422, '检测到不支持的挑战'],
        ['TooManyRequests', 429, '浏览器并发已满'],
        ['InternalError', 500, '内部错误'],
        ['Timeout', 504, '请求总预算耗尽'],
      ].map(([name, code, description]) => [
        name,
        {
          description,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
              example: { code, message: description, cached: false },
            },
          },
        },
      ])
    ),
  },
}

const docsHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CF Bypass API</title>
  <style>body{margin:0;background:#fafafa}redoc{display:block}</style>
</head>
<body>
  <redoc spec-url="/openapi.json"></redoc>
  <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`

module.exports = { openApiDocument, docsHtml }
