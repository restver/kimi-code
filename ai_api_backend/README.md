# ai_api_backend — Okta 登录链路测试后端

一个零依赖 Node 进程，同时扮演三个角色，用来端到端测试插件的 Okta 登录、模型供给、发消息、token 生命周期：

| 角色 | 端点 | 说明 |
|---|---|---|
| Okta IdP | `GET /v1/authorize` | 校验 client_id/redirect_uri/PKCE，自动同意，302 回 `redirect_uri?code&state` |
| | `POST /v1/token` | `authorization_code`（PKCE S256 校验）与 `refresh_token`（**轮换**：旧 refresh 用一次即作废，复用返回 invalid_grant） |
| 模型目录 | `GET /models` | 返回你们的目录格式 `{data:[{model,name,provider,apiBase,contextLength}]}`；需要有效 access token（`Authorization: Bearer` 或 `api-key` 头），无效/过期 → 401 |
| 推理 | `POST /v1/responses`、`POST /v1/chat/completions` | 同样校验 token（过期 → 401），回最小 SSE 流 |
| 管理台 | `GET /admin/state` | 查看已发 token 的剩余 TTL、计数器 |
| | `POST /admin/revoke` | 作废全部 refresh token → 下次刷新 invalid_grant → 插件应清会话要求重登 |
| | `POST /admin/expire` | 立刻作废全部 access token → 下个请求 401 |

## 启动

```bash
node server.mjs                     # 默认 127.0.0.1:9000，access token TTL=120s
TOKEN_TTL=1200 node server.mjs     # 20 分钟 TTL（测静默轮换不踩 401）
PORT=9001 node server.mjs
```

模型清单默认内嵌 3 个（gpt-test-mini / gpt-test-pro / qwen-test，provider 标 openai 与 openrouter 各有）；放一个 `models.json` 在本目录即可覆盖（格式同 `/models` 响应）。

## 插件侧配置（~/.kimi-code/）

`okta.json`（issuer 允许 localhost 的 http，插件已放行仅限 localhost）：

```json
{
  "issuer": "http://127.0.0.1:9000",
  "clientId": "0oa-test-mock-client",
  "authMode": "okta"
}
```

`gateway.json`（tokenHeaders 按需；protocolAliases 把目录标签映射到实际协议）：

```json
{
  "modelsBaseUrl": "http://127.0.0.1:9000",
  "modelsPath": "/models",
  "protocolAliases": { "openai": "openai_responses", "openrouter": "openai_responses" },
  "headers": { "version": "1.1.1", "name": "agent" },
  "tokenHeaders": { "apiKey": "{token}" }
}
```

## 测试场景

| 想测什么 | 怎么做 | 预期 |
|---|---|---|
| 完整登录 | 默认启动 → 插件点 Sign in with Okta | 浏览器开 `127.0.0.1:9000/v1/authorize` → 302 深链回 VS Code → 模型下拉出现 3 个模型 |
| 发消息 | 选中任一模型发一句 | 回复 "Hello from the mock backend. Your token works."；后端日志出现 `💬 responses` |
| token 静默轮换 | `TOKEN_TTL=1200` 启动 | 每 5 分钟 tick 时 token 已过半衰期 → 后端日志出现 `✅ token pair issued (refresh)`，无 401 |
| 过期 → 401 → 自愈 | 默认 `TOKEN_TTL=120` | 2 分钟后发消息 401（后端日志 `⛔ access token rejected: expired`）；下个 5 分钟 tick 刷新自愈 |
| refresh 失效 → 重登 | 登录后 `curl -X POST :9000/admin/revoke` | 下次刷新 invalid_grant → 插件清会话 → 回登录页 |
| 立即触发 401 | `curl -X POST :9000/admin/expire` | 所有 access token 立刻失效 |
| PKCE 篡改 | `node test-flow.mjs --bad-pkce` | token 端点 400 invalid_grant |
| 状态查看 | `curl :9000/admin/state` | 各 token 剩余 TTL、计数器 |

## 冒烟测试（不开 VS Code 也能跑）

```bash
node server.mjs &        # 终端 1
node test-flow.mjs       # 终端 2：登录→models→推理→刷新→过期→401 全链路
```


**token 过期测试的三个旋钮**
```shell
  cd ai_api_backend &&  node server.mjs                        # TTL=120s：2分钟后发消息→401（后端日志 ⛔ expired）→5分钟 tick 自愈
  TOKEN_TTL=1200 node server.mjs         # TTL=20min：过半衰期后 tick 静默轮换（✅ issued (refresh)），无 401
  curl -X POST :9000/admin/revoke        # 杀掉全部 refresh token → 下次刷新 invalid_grant → 插件清会话回登录页
  curl -X POST :9000/admin/expire        # 立刻作废全部 access token（不用等 TTL）
  curl :9000/admin/state                 # 实时看每个 token 剩余秒数 + 计数器
```
