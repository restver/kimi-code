# Okta SSO 登录 + 自有 API 模型供给 · 实施总结

> 时效基线：2026-09-01，基于本仓库工作区未提交变更（fork 定制，未合入上游）。
> 关联文档：同目录 `structured-okta.md` 为**设计文档（最终形态）**——为什么这么设计、全部配置契约、边界情况与设计演变记录；本文是**实施总结**——文件清单、验证结果、人工待办。两篇互补，遇到"为什么"查设计文档，"改了什么/怎么验"查本文。

## 链路（Continue 流程的移植，回调改用回环服务器免托管页）

```
OktaLoginScreen 点击 → oktaLogin RPC（16min 超时）
  → vscode.authentication.getSession("kimi-code-okta", …, {createIfNone})
  → AuthenticationProvider: PKCE + 回调通路二选一（redirectUri → vscode:// 深链；默认 loopback + asExternalUri）
  → 广播 OktaLoginUrl（兜底链接）→ 开浏览器 → Okta 授权 → 回调 code+state
  → POST {issuer}/v1/token 换 token
  → SecretStorage 存完整会话 + setMemoryConfig 注入引擎内存层（零落盘）
  → GET {modelsBaseUrl}/models（Bearer）→ 解析目录（每条含 model/name/provider/apiBase/contextLength）
  → 按 (protocol, apiBase) 分组 → applyOktaProviderConfig
  → replaceConfigSections 写 config.toml（每组一个 provider 段，全部 apiKey 空串）
  → {success:true} → onLoginSuccess → refresh() → 聊天 UI 直接可用
```

## token 安全设计

token 只存在于两处，全链路零文件写入（已 grep 核实）：

1. **VS Code SecretStorage**：事实源，固定 key `kimi-code.okta`，存自包含会话（access + refresh token、账号标签、**生成的 provider 段名单**——重启恢复因此不需要 okta.json），refresh token 永不离开这一层。
2. **引擎内存配置层**（`harness.setMemoryConfig({providers:{[name]:{apiKey: token}}})`）：引擎每请求从有效配置视图解析 Bearer；深合并、不落盘、`reload()` 后仍存活。重启后由 runtime 在激活期自动重注入；TTL/2 + 5 分钟 tick 主动刷新，刷新即自动重新注入。

config.toml 里 provider 写 `apiKey: ""`（引擎视为"未设置"），`~/.kimi-code/credentials/` 零写入。引擎侧 `ConfigTarget.Memory` 是一等公民（klient 契约 `z.enum(['user','memory'])` + agent-core-v2 configService 的 set/replace/replaceSections 三处 memory 分支）。

## 模式开关（Okta 为默认）

**Okta 是默认登录方式**：webview 乐观种子、RPC 失败回退、宿主 `readOktaMode` 三处默认值均为 `"okta"`。唯一的退回口：okta.json 写 `"authMode": "kimi"` → `LoginScreenGate` 渲染内置 `LoginScreen`（该文件一行未改）。

**模块生命周期**（与 Continue 官方同款）：

- **激活期**（`initOktaModule`，两行接线）：注册 `vscode.authentication.registerAuthenticationProvider`（**不需要 okta.json**——provider 的 config 全部在方法被调用时懒解析）+ `restoreOnActivation()`。永不抛错。
- **重启恢复零 config 依赖**：SecretStorage 固定 key `kimi-code.okta`，存的自包含会话 `{token, accountLabel, providerNames}`（供给后的段名名单）——恢复（向名单里每个段重注入引擎内存层）只读这一个 secret，**不读任何配置文件**；token 过半衰期才需要刷新（刷新才要 issuer/clientId）。okta.json 缺失时降级为"注入现有 token、不启动刷新定时器"。
- **两个配置文件都只在真正需要时读**（各自 loader 按 mtime 记忆化）：okta.json 管登录/刷新/判模式，gateway.json 管拉模型与供给。
- **`GetAuthMode` 纯读**，返回 `{mode, error}`；**错误不静默**：okta.json 缺失/非法或 RPC 失败 → mode 仍为 `"okta"`，`error` 显示在 Okta 页面的红色横幅上；gateway.json 缺失在点击登录时报错上浮。

## 配置文件全量示例（两个文件，各管一摊）

配置拆成两个文件：**okta.json 只管身份**（怎么登录），**gateway.json 只管你们自己的网关**（登录后调谁）——IdP 和网关由不同的人管、变更时机也不同，分开后互不牵连。两个都在 `~/.kimi-code/` 下。

### okta.json（Okta IdP）

`issuer`、`clientId` 必填，其余可省：

```json
{
  "issuer": "https://example.okta.com",
  "clientId": "0oa1abcd2EFgHiJkLmN3",
  "redirectUri": "vscode://life-restver-rd.restver-code/callback",
  "scopes": "openid profile email offline_access",
  "authorizePath": "/v1/authorize",
  "tokenPath": "/v1/token",
  "callbackPorts": [35173, 35174, 35175],
  "redirectPath": "/callback",
  "loginTimeoutMs": 600000,
  "authMode": "okta"
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `issuer` | string | **必填** | Okta 授权服务器的身份 URL，端点由它拼出（`{issuer}/v1/authorize`、`{issuer}/v1/token`）。Org 授权服务器填裸域名 `https://你的域.okta.com`；自定义授权服务器（Security → API 里建的）填 `https://你的域.okta.com/oauth2/<id>`（常见 `/oauth2/default`）。验证：访问 `{issuer}/.well-known/openid-configuration`，JSON 里的 `issuer` 字段与所填一致即对 |
| `clientId` | string | **必填** | Okta OIDC 应用（即 OAuth2 应用，同一东西）的 client_id |
| `redirectUri` | string | 无（走回环） | **vscode:// 深链回调**：配置后 authorize 与 token 交换都用它，code 经 `registerUriHandler` 回到插件。需与 Okta 应用注册的 redirect URI 一致，且与本插件 `publisher.name` 路由一致（`vscode://life-restver-rd.restver-code`）；state 不匹配的迟到深链被忽略。不配 → 默认回环 server（callbackPorts/redirectPath） |
| `scopes` | string | `"openid profile email offline_access"` | 空格分隔；`offline_access` 必须保留，否则拿不到 refresh token |
| `authorizePath` | string | `"/v1/authorize"` | Okta 授权端点路径 |
| `tokenPath` | string | `"/v1/token"` | Okta token 端点路径 |
| `callbackPorts` | number[] | `[35173, 35174, 35175]` | 回环回调端口，按序尝试；**每个端口都要在 Okta 应用里注册为 redirect URI** |
| `redirectPath` | string | `"/callback"` | 回调路径，与注册的 redirect URI 保持一致 |
| `loginTimeoutMs` | number | `600000`（10 分钟） | 等浏览器完成授权的总预算（webview RPC 超时 16 分钟 > 此值） |
| `authMode` | string | `"okta"` | 登录页选择：`"okta"`（默认）或 `"kimi"`（退回内置 Kimi 登录页）；其他值报错 |

### gateway.json（你们自己的 API · 只管模型目录）

**每个模型条目自带推理端点与协议，推理地址不在这个文件里**。`modelsBaseUrl` 必填，其余可省：

```json
{
  "modelsBaseUrl": "https://api.example.internal",
  "modelsPath": "/models",
  "providerName": "okta",
  "defaultContextLength": 128000,
  "protocolAliases": { "openai": "openai_responses", "openrouter": "openai_responses" }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `modelsBaseUrl` | string | **必填** | 模型目录接口的 base（只用于 GET 模型列表；推理打每个模型自己的 apiBase） |
| `modelsPath` | string | `"/models"` | 目录路径，拼在 modelsBaseUrl 后 |
| `providerName` | string | `"okta"` | 生成的 config.toml provider 段名前缀（所有权标记：凡此前缀的段/别名归我们管理、随目录增删） |
| `defaultContextLength` | number | `128000` | 兜底窗口大小（目录条目缺 `contextLength` 或解析失败时用它） |
| `protocolAliases` | object | `{}` | 目录标签 → 实际推理协议的**唯一映射来源（代码里零猜测）**。目录的 `provider` 字段写厂商标记而非线上协议时，每个标签都要在这里显式映射；例如全部标 `openai`/`openrouter` 但网关实际走 Responses API，就写上面示例的两行。未映射且不是受支持协议的标签会报错点名（不会静默走错协议）；值也必须是受支持的协议 |

**目录响应格式**（`GET {modelsBaseUrl}{modelsPath}`，Bearer 认证）：

```json
{
  "data": [
    {
      "model": "gpt-5.4",
      "name": "gpt-5.4",
      "provider": "openai",
      "apiBase": "https://one.example.internal/v1",
      "contextLength": "200000"
    }
  ]
}
```

| 字段 | 用途 |
|---|---|
| `model` | 推理请求里填的模型 id（也接受 `id` 字段） |
| `name` | 显示名（模型下拉标签；缺省用 model） |
| `provider` | 协议**标签**：本身是受支持的协议名就直接用作 `type`；是厂商标记（如 `openrouter`）则必须在 gateway.json 的 `protocolAliases` 里映射，未映射报错点名（不静默猜）。受支持协议：`openai`（Chat Completions）/ `openai_responses`（Responses API）/ `anthropic` / `kimi` / `google-genai` / `vertexai` |
| `apiBase` | **该模型自己的推理端点**（provider 段的 baseUrl） |
| `contextLength` | 窗口大小（字符串/数字均可），逐模型写 `maxContextSize`；缺失用 defaultContextLength |

**供给结果**（按 `(协议, apiBase)` 分组，每组一个段；段名 `<前缀>-<协议>` 短名（同协议第二组 `-2`）；每个模型条目显式写 `protocol` 满足聊天 preflight 的 `models.<id>.protocol` 校验）：

```toml
[providers.okta-openai]
type = "openai"
baseUrl = "https://one.example.internal/v1"
apiKey = ""

[providers.okta-anthropic]
type = "anthropic"
baseUrl = "https://two.example.internal/v1"
apiKey = ""

[models."okta-openai/gpt-5.4"]
provider = "okta-openai"
model = "gpt-5.4"
displayName = "gpt-5.4"
protocol = "openai"
maxContextSize = 200000
```

token（同一个 Okta token）注入到**每一个**生成的 provider 段（引擎内存层）；段名在供给完成后快照进 SecretStorage 会话，重启恢复按名单逐个注入。目录变化后重新登录即自愈：带前缀但不在新目录里的段与别名被删除，他人配置不动。

两个文件的解析规则相同（各自模块）：必填字段缺失/非法 → 抛带字段名的错误（经 `GetAuthMode`/`oktaLogin` 上浮到 Okta 页面横幅）；按文件 mtime+size 记忆化。

## 文件清单

**新增 12 个文件**（零冲突）：

| 文件 | 职责 |
|---|---|
| `apps/vscode/src/okta/okta-config.ts` | 读 `~/.kimi-code/okta.json`（纯 IdP：issuer/clientId 必填，其余有默认值），mtime 记忆化，只在需要时被调用；`authMode: "kimi"` 是退回 Kimi 登录的唯一开关 |
| `apps/vscode/src/okta/gateway-config.ts` | 读 `~/.kimi-code/gateway.json`（模型目录：modelsBaseUrl 必填 + modelsPath/providerName/defaultContextLength 兜底），mtime 记忆化——与 IdP 配置分开，各自独立变更 |
| `apps/vscode/src/okta/pkce.ts` | PKCE S256（64 字符 verifier、base64url challenge）、随机 state |
| `apps/vscode/src/okta/loopback.ts` | 回环回调服务器：按序试端口（默认 35173-35175）、state 校验、IdP error 短路、dispose 收尾 |
| `apps/vscode/src/okta/token-store.ts` | SecretStorage 存取（固定 key `kimi-code.okta`，自包含会话含段名名单 + `updateProviderNames` 供给后回填）+ 多段引擎注入器（`createEngineInjector`）+ TTL/2 刷新调度（单飞） |
| `apps/vscode/src/okta/auth-provider.ts` | `AuthenticationProvider`：构造零 config（调用时懒解析 okta.json）、浏览器授权全流程、token 交换、refresh（`invalid_grant` → 类型化错误并清存储）、`restoreOnActivation`（重启恢复，零 config 路径）、双击单飞 |
| `apps/vscode/src/okta/models.ts` | `fetchOktaModels`（解析 `{data:[{model,name,provider,apiBase,contextLength}]}`，协议/apiBase 校验，按三元组去重）、`applyOktaProviderConfig`（纯函数：按 `(protocol,apiBase)` 分组建段 `<前缀>-<协议>-<主机名>`、逐模型别名、所有权自愈）、`provisionOktaModels`（`replaceConfigSections` 原子写，返回段名名单）、`removeOktaProviders` |
| `apps/vscode/src/okta/runtime.ts` | 单例装配：`initOktaModule`（激活期注册 AuthenticationProvider + 触发 `restoreOnActivation`，永不抛错）、`readOktaMode`（纯读，供 GetAuthMode）、`requireOktaConfig`（登录/刷新/供给用）、`ensureOktaRuntime`（幂等兜底） |
| `apps/vscode/src/handlers/okta.handler.ts` | 四个 RPC：OktaLogin（`requireOktaConfig` + 全链编排）、OktaStatus、OktaLogout、GetAuthMode（纯读，返回 `{mode, error}`，错误上浮到 Okta 页面） |
| `apps/vscode/webview-ui/src/components/OktaLoginScreen.tsx` | 登录界面（状态机复刻 LoginScreen：idle/pending/error + URL 兜底卡 + `initError` 横幅显示 okta.json 配置错误） |
| `apps/vscode/webview-ui/src/components/LoginScreenGate.tsx` | 按 authMode 选登录页的唯一切换点，错误透传给 Okta 页 |
| `apps/vscode/webview-ui/src/hooks/useAuthMode.ts` | 模块级缓存的 `{mode, error}` 查询；RPC 失败不静默，错误带回页面 |
| `apps/vscode/test/okta.test.ts` | 33 个单测：双配置文件解析（okta + gateway）/PKCE/loopback 真服务器/**目录解析与分组供给（含陈旧组自愈、重登录名稳定、同主机同协议后缀）**/token store（含 updateProviderNames）/**重启恢复零 config 回归**/协议四方法与 GetAuthMode 错误契约 |

**上游文件仅 5 处追加约 33 行**（上游拉取冲突面极小）：

| 文件 | 改动 |
|---|---|
| `apps/vscode/shared/bridge.ts` | +10（4 个 Methods、1 个 Event、validateParams 四个 case） |
| `apps/vscode/src/handlers/index.ts` | +2（import + `...oktaHandlers`） |
| `apps/vscode/src/extension.ts` | +2（import + `initOktaModule`：注册 provider 与重启恢复，不读 okta.json） |
| `apps/vscode/webview-ui/src/services/bridge.ts` | +16（四个包装方法，`oktaLogin` 复用 16 分钟超时） |
| `apps/vscode/webview-ui/src/App.tsx` | 改 2 行（LoginScreen → LoginScreenGate） |

**配套**（并行完成）：node-sdk 增加 `setMemoryConfig`/`clearMemoryConfig`（base NOT_IMPLEMENTED + v2 实现 + 42 测试）；`.changeset/okta-sso-login.md`（`"kimi-code": patch`，按既有先例）。

### 登录状态与退出链路修复（实测反馈的两个问题，typecheck ✓ 402/402 ✓ lint 0 error）

**问题 1：设置弹窗的 Sign in 状态错 + 点击走 Kimi 登录。** 

**根因**：弹窗状态读 `checkLoginStatus`（查 **Kimi** token，Okta 登录后永远 false），动作调 `bridge.login()/logout()`（Kimi 通道）。

**修复**：

- `auth.handler.ts` 的 `CheckLoginStatus` 在 okta 模式（默认）下改报 **Okta 会话状态**（登录后弹窗自动变 Sign out，`useAppInit` 的 `setIsLoggedIn` 同源受益）

- `ActionMenu.tsx` 动作按模式路由（okta → `bridge.oktaLogin()/oktaLogout()`）。

**问题 2：VS Code 左下角头像退出后回不到登录页。** 

**根因**：头像退出走 `provider.removeSession()` 只清会话，**没删 config.toml 里供给的模型**（模型还在 → init 判 `ready` → 留在主界面），webview 也无人通知。

**修复**（`removeSession` 成为全量清理的统一退出路径）：

1. 清会话（SecretStorage + 引擎内存层）
2. 逐个删除供给的 provider 段（`harness.removeProvider`，模型别名级联清理）+ 重读配置
3. 新增 `OktaSessionChanged` 广播：`tokenStore.onClear` → 宿主 `provider.broadcast` → 所有 webview → `App.tsx` 订阅后 `refresh()` → 零模型 + 未登录 → **回到 Okta 登录页**
4. `oktaLogout` RPC 简化为直接调 `removeSession()`——弹窗与头像两条退出路径走同一份逻辑

广播只在**退出**时发（`onClear`），token 静默轮换不触发界面刷新闪烁。新增 3 个测试（okta 模式状态检查、kimi 模式回退、removeSession 全清理断言）。

验证步骤：装新 VSIX → 登录 → 弹窗应显示 Sign out → 分别从弹窗和头像退出 → 都应回到 Okta 登录页，config.toml 的 okta 段被清空。

### 同期落地（前文已详述，此处记入清单）：网关推理 header（`headers` 静态 + `tokenHeaders` 值模板 `{token}`）、完整行注入（修复内存层"整段遮蔽"导致的 `api.openai.com/v1` 漂移）、本地 Okta mock 后端 `ai_api_backend/`（server.mjs 三合一 + test-flow.mjs 冒烟 7/7 + okta.json 放行 localhost http issuer）。

## 验证结果（终态）

- typecheck 两个 tsconfig（extension host + webview）通过（migration-legacy 在 study 分支有既有报错，与 okta 无关）
- apps/vscode 全量测试 **402/402** 通过（含 okta 全部测试；mock 后端冒烟另测 7/7 + bad-PKCE 2/2）
- node-sdk `sdk-rpc-client-v2.test.ts` **42/42** 通过
- oxlint 新文件 0 error（余下 warning 与上游既有模式一致）
- token 落盘路径 grep 清零

## 待办（人工步骤）

1. Okta 管理台建应用（已有的 OAuth2/OIDC 应用直接复用）：Sign-in method 选 **OIDC - OpenID Connect**（即 OAuth2 应用，同一东西），Application type 选 **Native 或 SPA**（公共客户端 + PKCE）；Grant types 勾 **Authorization Code**（带 PKCE）+ **Refresh Token**；Sign-in redirect URIs 按回调方式二选一：**深链模式**（管理员已注册 `vscode://…`）→ okta.json 配同样的 `redirectUri`；**回环模式**（默认）→ 注册 `http://localhost:35173/callback`、`http://localhost:35174/callback`、`http://localhost:35175/callback`
2. 写两个配置文件：`~/.kimi-code/okta.json`（最小只需 issuer + clientId）+ `~/.kimi-code/gateway.json`（最小只需 apiBaseUrl），按上文全量示例
3. F5 起 Extension Development Host 走一遍真实登录 → 验证 config.toml 供给段、聊天发消息带 Bearer、登出清理（也可先用 `ai_api_backend/` 本地 mock 走全链）
4. ~~变更未提交 git~~ → 已提交并推送 `origin/study`（截至 `ef02e752` + 登录状态/退出修复一笔待提交）



**遗留风险（已解决）**

此前记录的风险——引擎 memory 层"整段遮蔽"（`configService.ts:581-585`）导致注入 `{apiKey}` 会把 provider 行的 `baseUrl`/`type` 连同其他 provider 一起遮蔽（表现为请求漂到 `api.openai.com/v1`）——**已通过"完整行注入"修复**：注入器现写入 `{type, baseUrl, customHeaders(静态+token模板渲染), apiKey}` 全量行，行数据快照在 SecretStorage 会话（`providerRows`），重启恢复零配置。注意：内存层仍是整段替换语义——非 okta 的手配 provider 在有 okta 会话期间仍会被遮蔽（当前部署全是 okta 模型，无影响；若将来混配需把注入基底换成"磁盘全量 + token"）。
