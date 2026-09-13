# Kimi 登录流程:token 下发与模型配置(白话版)

> 时效基线:2026-09-05,okta_login 分支(HEAD 3b4439a9a)。
> 实测基线:文中行号当日逐文件核对;代码演进后以仓库实际为准。

先一句话说清整件事:你点一次"登录",程序会 ①连登录服务器拿一串当钥匙用的字符串(token),存进你电脑的凭据文件;②再拿这串钥匙去问服务器"有哪些模型可用",把答案写进 config.toml 配置文件。以后每次对话请求,程序就按配置文件里留的"token 存放指引"找到凭据文件,取出钥匙塞进请求头发出去。下面按发生顺序讲六步。

### 第 1 步:起点 —— 你在界面上点"登录"

文件:apps/vscode/webview-ui/src/components/ActionMenu.tsx、apps/vscode/webview-ui/src/services/bridge.ts、apps/vscode/src/handlers/auth.handler.ts

1.1 你点登录按钮 → 组件调 `bridge.login()`(ActionMenu.tsx:86)。

1.2 `bridge.login()` 的实现(bridge.ts:129-131)就一行:给扩展发一条消息,消息名是 `Methods.Login`(就是字符串 "login" —— webview 和扩展代码不在同一个进程里,双方靠"约定好消息名"互相传话,这套机制叫 bridge)。

1.3 扩展这边有一张登记表,记录"每种消息谁来处理":`[Methods.Login]` 这一条登记在 auth.handler.ts:16。它自己不写任何登录逻辑,只做一件事 —— 调 `ctx.harness.auth.login(undefined, { onDeviceCode })`(auth.handler.ts:18),同时把一个回调函数 onDeviceCode 塞进去(它的用途见第 3 步 3.3b:等拿到"给用户看的链接"时,靠它送回界面)。

1.4 `ctx.harness.auth` 是 SDK 里专门管登录的对象,类型叫 KimiAuthFacade → 进入第 2 步。

### 第 2 步:总台接单 —— KimiAuthFacade(packages/node-sdk/src/auth.ts:136)

先解释名字:门面(facade)= 总台。外面只需要喊"登录/登出",底下连哪台服务器、存哪个文件、叫哪个工人干活,总台自己安排,外面不用知道。

**2.1** 总台先决定"这次登录连哪个环境"。真实代码只有短短九行(packages/node-sdk/src/auth.ts:140-148),四个来源就是在这里被组装出来的:

```ts
    const { region, ...loginOptions } = options;
    const regionHosts = region === undefined ? undefined : kimiRegionLoginHosts(region);
    const auth = this.resolveManagedAuth(providerName);
    const loginAuth = resolveKimiCodeLoginAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: auth.oauthRef,
      requestedBaseUrl: loginOptions.baseUrl ?? regionHosts?.baseUrl,
      requestedOAuthHost: loginOptions.oauthHost ?? regionHosts?.oauthHost,
    });
```

一行一行看它怎么把几路输入凑齐:

**第 1 行**:把调用方传的 region 单独拎出来,剩下的参数(baseUrl / oauthHost 等)留在 loginOptions 里。

**第 2 行 regionHosts = region === undefined**:region → 两个地址的换算。`kimiRegionLoginHosts` 查一张写死的对照表(region.ts:47-62):

```ts
export const KIMI_REGION_PROFILES: Record<KimiRegion, KimiRegionProfile> = {
  'mainland-cn': {
    oauthHost: DEFAULT_KIMI_CODE_OAUTH_HOST,
    baseUrl: DEFAULT_KIMI_CODE_BASE_URL,
    cdnBase: 'https://code.kimi.com/kimi-code',
    siteBase: 'https://www.kimi.com',
    telemetryEndpoint: 'https://telemetry-logs.kimi.com/v1/event',
  },
  global: {
    oauthHost: 'https://auth.kimi.ai',
    baseUrl: 'https://api.kimi.ai/coding/v1',
    ...(cdn / site / telemetry 同样换成 .ai 域)
  },
};
```

| region | oauthHost(登录) | baseUrl(模型 API) |
|---|---|---|
| mainland-cn(默认) | https://auth.kimi.com | https://api.kimi.com/coding/v1 |
| global(国际) | https://auth.kimi.ai | https://api.kimi.ai/coding/v1 |

`kimiRegionLoginHosts` 在两种情况下会返回 undefined,分开看:

- 情况一:调用方没传 region —— VS Code 扩展就是这个情况(auth.handler.ts:18 只塞 onDeviceCode 回调,不传 region)。条件 `region === undefined` 成立, 直接取 `undefined`,冒号右边的 `kimiRegionLoginHosts(region)` 根本不会执行,所以 VS Code 登录时 regionHosts 恒为 undefined:

```ts
    const regionHosts = region === undefined ? undefined : kimiRegionLoginHosts(region);
```

- 情况二:调用方传了 region(比如你在 CLI 敲 `kimi login --region global`)。这时函数会被调用 —— 但看它的开头:

```ts
export function kimiRegionLoginHosts(
  region: KimiRegion,
  env: NodeJS.ProcessEnv = process.env,
): { readonly oauthHost: string; readonly baseUrl: string } | undefined {
  if (kimiCodeEnvOAuthHost(env) !== undefined || kimiCodeEnvBaseUrl(env) !== undefined) {
    return undefined;   // ← 环境变量设了任何一个,region 参数作废
  }
```

代码里 `kimiCodeEnvOAuthHost(env)` / `kimiCodeEnvBaseUrl(env)` 读的就是环境变量 `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` / `KIMI_CODE_BASE_URL`;

```ts
export function kimiCodeEnvBaseUrl(env: ManagedKimiEnv = process.env): string | undefined {
  return env.KIMI_CODE_BASE_URL;
}

export function kimiCodeEnvOAuthHost(env: ManagedKimiEnv = process.env): string | undefined {
  return env.KIMI_CODE_OAUTH_HOST ?? env.KIMI_OAUTH_HOST;
}
```

只要你设了其中任何一个,函数看都不看 region 参数,直接 `return undefined`—— 意思是"region 的换算作废,地址交给环境变量那一路决定"。

这两个函数(`kimiCodeEnvBaseUrl/kimiCodeEnvOAuthHost`):函数参数类型是 `ManagedKimiEnv`,接口里给每个变量都留了声明(managed-kimi-code.ts:106):

```ts
export interface ManagedKimiEnv {
  readonly KIMI_CODE_BASE_URL?: string | undefined;
  readonly KIMI_CODE_OAUTH_HOST?: string | undefined;
  readonly KIMI_OAUTH_HOST?: string | undefined;
}
```

全仓用到这两个函数的地方只有:

1. `kimiRegionLoginHosts` 中(根据是否在环境变量中设置了指定地址,来来选择是否忽略 `region` 定义的地址)

2. `resolveKimiCodeLoginAuth` 中拿到这个地址,根据条件,选择是否作为登录地址

全仓真正直接用 `process.env.KIMI_CODE_BASE_URL`只有一处 —— 用量统计、用户信息这类 URL(managed-usage.ts:42):

```ts
return (process.env['KIMI_CODE_BASE_URL'] ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, '');
```

你自己要用它,就在 shell 里 `export KIMI_CODE_BASE_URL=https://...` —— 给自建网关/代理用户留的后门。

为什么要这么设计?

先看会"打架"的场景:你在 CLI 敲 `kimi login --region global` —— region 会把模型 API 换算成 `https://api.kimi.ai/coding/v1`;可你的 shell 里恰好还设着 `export KIMI_CODE_BASE_URL=https://内网网关`。

同一个地址出现两个说法,必须定胜负。程序的裁定是:环境变量赢。两道闸保证这一点: 

- 第一道就是情况二代码的这段函数`kimiRegionLoginHosts` 开头的 `if (kimiCodeEnvOAuthHost(env) !== undefined`, `region` 换算直接作废;

- 第二道在下面的裁判逻辑里(resolveKimiCodeLoginAuth 的 baseUrl 取值,packages/oauth/src/managed-kimi-code.ts:397-402),环境变量排在 config 现值之前:

```ts
  const baseUrl =
    options.requestedBaseUrl !== undefined
      ? normalizeBaseUrl(options.requestedBaseUrl)  // 先是直接指定的或者region换算的
      : envBaseUrl !== undefined
        ? normalizeBaseUrl(envBaseUrl)              // 其次环境变量
        : options.configuredBaseUrl;                // 最后 config 现值
```

TUI 代码注释里那句 "env overrides keep priority"(环境变量覆盖保持优先)说的就是这条规则。

**最终顺序是**: 显式请求 > 环境变量 > 配置文件里已有的值。没有任何覆盖时，就用配置文件里的值；

**真实会传 region 的是两个终端入口,两者不一样,分开看**:

- TUI(终端里的交互界面,`/login` 命令):region 不是你敲的参数,而是看你登录时选了哪个平台。platformId 就是你在选择框里选出来的 —— `/login` 的处理函数开头(tui/commands/auth.ts:35-40):

```ts
export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code' || platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE) {
    const region: KimiRegion = platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE ? 'global' : 'mainland-cn';
```

`promptPlatformSelection`(tui/commands/prompts.ts:22)弹出标题为 "Select a platform" 的选择框

```
  Select a platform
  ↑↓ navigate · Enter select · Esc cancel
 
   ❯ Kimi Code (kimi.com/code)
     Kimi Code (kimi.ai/code)
     Kimi Platform (API key · platform.kimi.com)
     Kimi Platform (API key · platform.kimi.ai)

```

选项清单(tui/components/dialogs/platform-selector.ts:10-26):

```ts

const KIMI_CODE_MAINLAND_CN_OPTION: ChoiceOption = {
  value: 'kimi-code',
  label: 'Kimi Code (kimi.com/code)',
};
const KIMI_CODE_GLOBAL_OPTION: ChoiceOption = {
  value: KIMI_CODE_GLOBAL_PLATFORM_VALUE,   // = 'kimi-code-global'(utils/region.ts:32)
  label: 'Kimi Code (kimi.ai/code)',
};

function platformOptions(): readonly ChoiceOption[] {
  return [
    KIMI_CODE_MAINLAND_CN_OPTION,
    KIMI_CODE_GLOBAL_OPTION,
    ...OPEN_PLATFORMS.map((platform) => ({ value: platform.id, label: platform.name })),
  ];
}

export class PlatformSelectorComponent extends ChoicePickerComponent {
  constructor(opts: PlatformSelectorOptions) {
    super({
      title: 'Select a platform',
      options: [...platformOptions()],
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
```

所以 platformId = 你选中那一项的 value:国内 'kimi-code'、国际 'kimi-code-global',或开放平台清单(OPEN_PLATFORMS,来自 @moonshot-ai/kimi-code-oauth 包)里某项的 id;

取消则返回 undefined、命令直接结束。选中后, 这里 `tui/commands/auth.ts:39-43`, 把它折算成 region:国际 → 'global',国内 → 'mainland-cn':
```ts
    const region: KimiRegion = platformId === KIMI_CODE_GLOBAL_PLATFORM_VALUE ? 'global' : 'mainland-cn';
```

选的是开放平台则走另一条 `handleOpenPlatformLogin(auth.ts:44-46)`,不进这条 OAuth 流程。

然后调用 `handleKimiCodeOAuthLogin` (`tui/commands/auth.ts:50`):

```ts
    // The facade maps region → profile hosts (env overrides keep priority);
    // 'mainland-cn' is passed explicitly too so switching back overrides a
    // persisted global login.
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
```

切回国内区也要显式传 `region`,为的是盖过上次登录留下的国际区地址(那处注释原文:`'mainland-cn' is passed explicitly too so switching back overrides a persisted global login`)

- CLI(纯命令行,`kimi login --region global`):region 是你敲的命令行参数,login.ts:18-23 定义并解析:

```ts
    .option(
      '--region <region>',
      'Login region: "mainland-cn" (kimi.com) or "global" (kimi.ai).',
    )
    .action(async (opts: { region?: string }) => {
      await runLoginFlow({
        region: opts.region === undefined ? undefined : parseRegionFlag(opts.region),
      });
    });
```

最终在 login-flow.ts:40-42 传给 auth.login。和 TUI 的差别除了参数来源,还有 onDeviceCode 回调的用法:CLI 没有界面,回调把链接和验证码直接打印到终端(stderr),浏览器打不开时你照着手输:

```ts
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            `Opening browser for Kimi device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
```

**第 3 行 resolveManagedAuth**:读 config.toml 现值 —— `resolveManagedAuth`(`packages/node-sdk/src/auth.ts:294-308`)从 `[providers."managed:kimi-code"]` 段取出 `baseUrl` 和 `token 存放指引`。

`token 存放指引` = 下面 toml 里 `[providers."managed:kimi-code".oauth]` 那一小段,记录三件事:

1. token 存在哪个凭据文件(key 决定文件名)

2. 用什么方式存(storage)

3. 自建环境还多记一个登录服务器地址(oauthHost;官方默认环境省略不写)

```yaml
default_model = "kimi-code/kimi-k2-turbo-preview"

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
```

它本身不含 token, 代码里对应 `provider.oauth`,返回值取名 oauthRef。为什么这么设计、key 怎么算,第 6 步专讲:

```ts    
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    // Read path: token/status resolution must work off a degraded config
    // instead of failing the session when an unrelated section is broken.
    // Write paths (the toolkit's configAdapter.read) stay strict.
    const config = loadRuntimeConfigSafe(this.options.configPath).config;
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,   // ← token 存放指引,就是上面 toml 的 [providers."managed:kimi-code".oauth] 段;自建环境里面还带 oauthHost
      baseUrl: provider?.baseUrl,
    };
```

第一行的 `name` 是去 config.toml 的`providers`, 找段的键(`providers.`后面的东西):`providerName` 是可选参数,沿调用链传下来,三个入口实际传的:

- VS Code 是 `undefined`(auth.handler.ts:18 的 `login(undefined, ...)` 第一个参数就是它)、

- CLI 也是 `undefined`(login-flow.ts:40)、

- TUI 传 `DEFAULT_OAUTH_PROVIDER_NAME`, 值同样是 'managed:kimi-code'(apps/kimi-code/src/constant/app.ts:69)。

`??` 的意思:调用方没给就用默认名,所以三种情况下 `name` 都是 `KIMI_CODE_PROVIDER_NAME = 'managed:kimi-code'`(managed-kimi-code.ts:12)

下一行 `config.providers[name]` 拿它当键,只对应一个段:config.toml 里的 `[providers."managed:kimi-code"]`(键里带冒号,TOML 要求加引号)。

代码返回的 `provider.oauth`,取的是这个段里面嵌套的**小节** `[providers."managed:kimi-code".oauth]` —— 也就是 token 存放指引。

> 嵌套小节 = 嵌套对象

假设 `config.toml` 里有下面这段:

```
[providers."managed:kimi-code"]
type = "kimi"

[providers."managed:kimi-code".abc]
x = 1
```
解析出来就是：

```ts
config.providers["managed:kimi-code"] = {
  type: "kimi",
  abc: { x: 1 },        // ← provider.abc 能拿到,和 provider.oauth 同理
}
```
`provider.abc`、`provider.oauth` 拿法一模一样 —— `oauth` 没有任何特殊待遇，它只是“恰好叫 oauth 的一节”。

为什么 name 要做成参数?门面把这个接口设计成通用的:理论上 config.toml 可以有多个 `[providers.<别的名字>]` 段,传别的名字就查别的段。但实际今天三个入口(VS Code、CLI 传 undefined,TUI 传的常量值也是 'managed:kimi-code')全都落在这一个名字上,所以这个"通用"目前只用到一个名字,永远只查这一段。

具体到一份真实配置。你之前用国内区登录过一次,`~/.kimi-code/config.toml` 里就有这么一段(完整样子见第 7 步):

```toml
[providers."managed:kimi-code"]
type = "kimi"
baseUrl = "https://api.kimi.com/coding/v1"
apiKey = ""

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauthHost = "https://auth.kimi.com"

```

上面那段代码对这份配置取出的两个值就是:

- `baseUrl` → `"https://api.kimi.com/coding/v1"`

- `oauthRef`(token 存放指引)→ `{ storage: "file", key: "oauth/kimi-code", oauthHost: "https://auth.kimi.com" }` —— 裁判要的 oauthHost 就藏在 token 存放指引里

反过来,如果你从没登录过(首次登录),config.toml 里根本没有 `[providers."managed:kimi-code"]` 这一段,`config.providers[name]` 是 undefined,两个值都取不到(都是 undefined),裁判手里就没有 config 这一路,只能落到默认环境。

作用:登录过的用户,下次登录沿用上次的环境。

**第 4-8 行 resolveKimiCodeLoginAuth**:把前两行的结果打包,塞给最终裁判 `resolveKimiCodeLoginAuth`(`packages/oauth/src/managed-kimi-code.ts:390-402`)。对着 2.1 开头那段代码看四个入参的来历:

- `requestedBaseUrl` / `requestedOAuthHost` ← 本次参数。取值顺序是"显式传的地址优先于 region 换算的地址":`loginOptions.baseUrl ?? regionHosts?.baseUrl` 读作"调用方直接给了 baseUrl 就用它的,没给才用 region 换算出来的那个";

- `configuredBaseUrl` / `configuredOAuthRef` ← 第 3 行从 config.toml 读出来的现值(baseUrl 和 token 存放指引);

- 环境变量不在入参里 —— 裁判函数内部自己读(见下面判决逻辑的头两行)。

裁判的判决逻辑:

```ts
  const envBaseUrl = kimiCodeEnvBaseUrl(env);
  const envOAuthHost = kimiCodeEnvOAuthHost(env);
  const hasOverride =
    options.requestedBaseUrl !== undefined ||      // 本次参数
    options.requestedOAuthHost !== undefined ||
    envBaseUrl !== undefined ||                    // 环境变量
    envOAuthHost !== undefined;
  const baseUrl =
    options.requestedBaseUrl !== undefined
      ? normalizeBaseUrl(options.requestedBaseUrl)  // 参数最优先
      : envBaseUrl !== undefined
        ? normalizeBaseUrl(envBaseUrl)              // 其次环境变量
        : options.configuredBaseUrl;                // 最后 config 现值
```

判决分两条路:

- **有覆盖**(本次参数或环境变量给了任何一个,`hasOverride` 为真):直接按上面代码里的三级顺序"参数 > 环境变量 > config 现值"取值返回,不做任何核对。

- **无覆盖**(参数、环境变量都没给):用 config 现值,另外多做一步核对(managed-kimi-code.ts:406-414)—— 拿旧 token 存放指引里的 oauthHost 加上现在的 baseUrl,重算一个"期望 key",和旧 token 存放指引里存的 key 比对。

期望 key 的算法在 resolveKimiCodeOAuthKey(managed-kimi-code.ts:321-337):

默认环境(登录服务器和模型 API 都是官方地址)返回固定值 `'oauth/kimi-code'`;

其他任何环境,把两个地址拼在一起做 sha256、取前 16 位十六进制,再拼上前缀 `'oauth/kimi-code-env-'`:

```ts
  if (oauthHost === defaultOauthHost && SHARED_DEFAULT_BASE_URLS.includes(baseUrl)) {
    return KIMI_CODE_OAUTH_KEY;                              // = 'oauth/kimi-code'
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `${KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX}${digest}`;     // 'oauth/kimi-code-env-' + 前 16 位
```

  和旧 token 存放指引比对的代码是这段:

```ts
  const configured = configuredOAuthRef(options.configuredOAuthRef);
  if (configured === undefined) return { baseUrl, oauthHost };
  const expectedKey = resolveKimiCodeOAuthKey({
    oauthHost: configured.oauthHost,
    baseUrl,
  });
  return configured.key === expectedKey
    ? { baseUrl, oauthHost, oauthRef: configured }
    : { baseUrl, oauthHost };
```

  比对一致 → 旧 token 存放指引原样带回去,老用户重新登录,token 存放指引不变;
  
  比对不一致(config 是别的环境留下的)→ 不带,按新环境重算。

至于谁都没给的 oauthHost 之类的字段,兜底在哪发生、怎么用上默认常量,分两条看:

- oauthHost 的兜底在接下来的 `toolkit.login` 里(packages/oauth/src/toolkit.ts:164):`const oauthHost = this.oauthHostFor(options.oauthRef, options.oauthHost);`。oauthHostFor 内部是三级取值(toolkit.ts:455-461):

```ts
  private oauthHostFor(
    oauthRef?: KimiOAuthTokenRef | undefined,
    oauthHost?: string | undefined,
  ): string {
    return oauthRef?.oauthHost ?? oauthHost ?? this.flowConfig.oauthHost;
  }
```

  flowConfig 的默认值来自构造(toolkit.ts:130 `options.flowConfig ?? KIMI_CODE_FLOW_CONFIG`)
  
  KIMI_CODE_FLOW_CONFIG(constants.ts:14-19)里 oauthHost 的取法是环境变量 → 默认常量:

```ts
export const KIMI_CODE_FLOW_CONFIG: OAuthFlowConfig = {
  name: 'kimi-code',
  oauthHost:
    envOverride('KIMI_CODE_OAUTH_HOST') ??
    envOverride('KIMI_OAUTH_HOST') ??
    DEFAULT_KIMI_CODE_OAUTH_HOST,        // ← 'https://auth.kimi.com' 在这被用上
```

- baseUrl 的兜底在 defaultBaseUrl(managed-kimi-code.ts:255-257),它包的就是上面贴过的 managed-usage.ts:42 那行 —— 注意又先过一遍环境变量:

```ts
function defaultBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '');   // kimiCodeBaseUrl() = 环境变量 ?? DEFAULT_KIMI_CODE_BASE_URL
}
```

  全仓用到 `defaultBaseUrl` 的地方就这一个文件(`packages/oauth/src/managed-kimi-code.ts`)的这三处。它们的共同点:传进来的 baseUrl 是可选的(四路来源可能谁都没给,是 undefined),但各自的用途都要求一个真实地址字符串,所以当场兜底:

- 算 key 时(:326)—— 在 resolveKimiCodeOAuthKey 里(就是 2.1 无覆盖分支贴过的那个函数;key 是 token 存放指引里那串标识,第 6 步细讲):key 要把 `{oauthHost, baseUrl}` 拼在一起做 sha256,undefined 拼不进哈希:

```ts
  const oauthHost = normalizeEndpoint(options.oauthHost ?? DEFAULT_KIMI_CODE_OAUTH_HOST);
  const baseUrl = defaultBaseUrl(options.baseUrl);        // :326,undefined 就变默认地址
```

- 拉模型时(:493)—— 在 fetchManagedKimiCodeModels 里(第 4 步 4.2 那个 `GET /models`):请求 URL 是 `${baseUrl}/models` 拼出来的,undefined 拼不出地址:

```ts
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = defaultBaseUrl(options.baseUrl);        // :493
  const response = await fetchImpl(`${baseUrl}/models`, {
```

- 写 provider 段时(:582)—— 在 applyManagedKimiCodeConfig 里(第 4 步 4.4b):config.toml 要落一个字符串值,不能落 undefined:

```ts
  const baseUrl = defaultBaseUrl(options.baseUrl);        // :582
  ...
  config.providers[KIMI_CODE_PROVIDER_NAME] = {
    type: 'kimi',
    baseUrl,        // ← 写进 config.toml 的就是它
```

两个常量的定义集中放在这:

```ts
// packages/oauth/src/constants.ts:3
export const DEFAULT_KIMI_CODE_OAUTH_HOST = 'https://auth.kimi.com';
// packages/oauth/src/managed-usage.ts:29
export const DEFAULT_KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
```

顺带:CLI 决定"默认用哪个 region"另有一条五级顺序(region.ts:6-20 注释):环境变量 > 已存的 oauthHost > 默认槽位登录(视为明确的国内区)> 安装渠道标记文件 `<home>/region`(安装脚本写的,仅首次登录前有效)> 默认 'mainland-cn'。

**2.2 总台把活整体派给工人**:`toolkit.login(name, { ..., provisionConfig: true })`(:149-155)。 `toolkit.login` 内部调用 `oauthHostFor`, 就是前边说的会给`oauthHost` 兜底, 设置默认值的地方。

注意这一个调用里打包了两件事 —— 拿token(第 3 步)+ 配置模型(第 4 步)。"配置模型"具体指:拿着刚到手的token去问模型 API"有哪些模型可用",把模型清单、默认模型、token 存放指引写进 config.toml。不做这一步,token虽然拿到了,但配置文件里一个模型都没有 —— 程序不知道该用哪个模型、往哪个地址发请求,等于白登录。

`provisionConfig` 就是"要不要做配置模型这一步"的开关;这里直接写死 `true`,而且配置模型没做成还整个登录报错(auth.ts:149-158):

```ts
    const result = await this.toolkit.login(providerName, {
      ...loginOptions,
      baseUrl: loginAuth.baseUrl,
      oauthHost: loginAuth.oauthHost,
      oauthRef: loginOptions.oauthRef ?? loginAuth.oauthRef,
      provisionConfig: true,        // ← 写死 true:登录必须连带配置模型
    });
    if (result.provision === undefined) {
      throw new Error('Kimi auth login did not provision model config.');   // ← 模型配置没做成 = 登录失败
    }
```

所以走门面登录,"只登录不配置模型"根本不是一个选项。

**2.3 两件事(2.1 和 2.2)都干完后,总台重新读一遍 config.toml**,然后调用 `onConfigUpdated` 回调(auth.ts:159-167):

```ts
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
```

注意 `?.`:onConfigUpdated 是可选参数(auth.ts:104,构造门面时传了才会执行)。而全仓搜下来**没有任何调用方传它** —— SDK 组装处(sdk-rpc-client-v2.ts:435-441)只传了 homeDir / configPath / identity / onRefresh 四样。
```ts
  this.auth = new KimiAuthFacade({
    homeDir: this.homeDir,
    configPath: this.configPath,
    identity: this.identity,
    onRefresh: options.onOAuthRefresh,
  });
```
所以在这个仓库里这行实际从不执行,是个预留的扩展点;调用方真正拿结果靠的是 **login 的返回值** —— 默认模型、thinking 配置都在上面那段 return 里。

logout 里也有同样的一行(:176),同样没人传。
```ts
  async logout(providerName?: string | undefined): Promise<KimiAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    const updated = readConfigFile(this.options.configPath);
  }
```
→ 接下来两步都发生在 2.2 那个调用内部,按执行顺序先看拿token。→ 进入第 3 步。

### 第 3 步:拿token —— 设备码登录

文件:packages/oauth/src/toolkit.ts、packages/oauth/src/oauth-manager.ts、packages/oauth/src/oauth.ts、packages/oauth/src/storage.ts

先解释流程名:设备码流程(RFC 8628)= 先让登录服务器发一个"待确认码",你在浏览器里登录并确认;程序在后台一遍遍问服务器"用户确认了吗",确认了服务器就把token发下来。适合命令行/插件这种没有网页窗口的程序。

3.1 先找到"干登录这件事的人",并定好 token 存哪个文件。

`toolkit.login`(toolkit.ts:159)第一步调 `managerFor(:164、:406-428)`,按环境找出一个 `OAuthManager` 对象(没有就新建) —— 它是真正干登录脏活的人:设备码流程(3.3)、token 的存取(3.3d、5.3)、token 的刷新(3.2b)全在它身上。

新建时给它两个关键参数:登录服务器地址 `oauthHost`、文件名 `name` —— 这个文件名就是将来存 token 的那个 json 文件名。看代码:

```ts
  private managerFor(
    providerName?: string | undefined,
    oauthKey?: string | undefined,
    oauthHost?: string | undefined,
  ): OAuthManager {
    const storageName = resolveKimiTokenStorageName({ providerName, oauthKey });
    const effectiveOAuthHost = oauthHost ?? this.flowConfig.oauthHost;
    const managerKey = `${storageName}\0${normalizeOAuthHost(effectiveOAuthHost)}`;
    let manager = this.managers.get(managerKey);
    if (manager !== undefined) return manager;
    ...
    manager = new OAuthManager({
      config: { ...this.flowConfig, oauthHost: effectiveOAuthHost, name: storageName },
      storage: this.storage,
```

- `storageName` 就是文件名,分两步算出来:

  第一步,算 key(环境指纹)—— toolkit.login 开头(toolkit.ts:163-164):

```ts
    const oauthHost = this.oauthHostFor(options.oauthRef, options.oauthHost);
    const oauthKey = options.oauthRef?.key ?? this.defaultOAuthKey(options.baseUrl, oauthHost);
```

`defaultOAuthKey`(toolkit.ts:438-446)内部就是调 resolveKimiCodeOAuthKey —— 算法代码在 2.1 无覆盖分支贴过, 在 resolveKimiCodeOAuthKey(managed-kimi-code.ts:321-337):

```ts
  if (oauthHost === defaultOauthHost && SHARED_DEFAULT_BASE_URLS.includes(baseUrl)) {
    return KIMI_CODE_OAUTH_KEY;                              // = 'oauth/kimi-code'
  }

  const digest = createHash('sha256')
    .update(JSON.stringify({ oauthHost, baseUrl }))
    .digest('hex')
    .slice(0, 16);
  return `${KIMI_CODE_SCOPED_OAUTH_KEY_PREFIX}${digest}`;     // 'oauth/kimi-code-env-' + 前 16 位
```

默认环境(登录服务器和模型 API 都是官方地址)返回固定值 `'oauth/kimi-code'`;

其他环境返回 `'oauth/kimi-code-env-' + sha256({oauthHost, baseUrl}) 前 16 位`。
  
  第二步 managerFor 内部,key → 文件名 —— resolveKimiTokenStorageName(toolkit.ts:472-484):

```ts
export function resolveKimiTokenStorageName(input: {
  readonly providerName?: string | undefined;
  readonly oauthKey?: string | undefined;
}): string {
  const key = input.oauthKey ?? KIMI_CODE_OAUTH_KEY;
  if (key === 'kimi-code' || key === KIMI_CODE_OAUTH_KEY) return 'kimi-code';

  const prefix = 'oauth/';
  if (key.startsWith(prefix) && key.slice(prefix.length).length > 0) {
    return key.slice(prefix.length);
  }
```

  规则:去掉 `'oauth/'` 前缀,剩下的就是文件名 —— 
  
  官方环境 `'oauth/kimi-code'` → `kimi-code`(token 存 `~/.kimi-code/credentials/kimi-code.json`);
  
  自建环境 `'oauth/kimi-code-env-<hash>'` → `kimi-code-env-<hash>`。3.3 的 d 步 `storage.save(this.config.name, ...)` 存的就是这个 storageName。

- `managers.get(managerKey)` 是个缓存:同一个(文件名, 登录服务器)组合复用同一个 OAuthManager,不重复建。

- 不同环境 → 不同文件名 → 官方登录和国际区登录的 token 各存各的文件,不会互相覆盖。

3.2 看槽里有没有旧 token(toolkit.ts:167-187),代码:

```ts
    const hadToken = await manager.hasToken();
    let usedDeviceLogin = false;
    const loginWithDevice = async (): Promise<string> => {
      usedDeviceLogin = true;
      return (
        await manager.login({
          signal: options.signal,
          onDeviceCode: options.onDeviceCode,
        })
      ).accessToken;
    };
    let accessToken: string;
    if (hadToken) {
      try {
        accessToken = await manager.ensureFresh();
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError)) throw error;
        accessToken = await loginWithDevice();   // ← 旧 token 已被服务器拒绝,重走设备码
      }
    } else {
      accessToken = await loginWithDevice();     // ← 从没存过 token,走设备码
    }
```

对上三个分支:

- a. 有、且还算新鲜 → `ensureFresh()` 判定不用换,直接返回现有 accessToken;

- b. 有、但剩余时间不足 → `ensureFresh()` 先用 refreshToken 换新(oauth.ts:226)再返回 —— refreshToken 是登录时一并发下的、有效期更长的那把钥匙;

- c. 没有(或被服务器拒绝)→ `loginWithDevice()`,走 3.3 的设备码流程。

a 和 b 的分界线在 shouldRefreshToken(oauth-manager.ts:459-465):

```ts
  private shouldRefreshToken(token: TokenInfo, force: boolean): boolean {
    if (force) return true;
    if (token.expiresAt === 0) return false;
    const remaining = token.expiresAt - this.now();
    return remaining < this.refreshThresholdFn(token.expiresIn);
  }
```

阈值默认值(oauth-manager.ts:31-36):

```ts
export function defaultRefreshThreshold(expiresIn: number): number {
  if (expiresIn > 0) {
    return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO);
  }
  return MIN_REFRESH_THRESHOLD_SECONDS;
}
```

两个常量(oauth-manager.ts:27-28):`REFRESH_THRESHOLD_RATIO = 0.5`(半)、`MIN_REFRESH_THRESHOLD_SECONDS = 300`(5 分钟下限,防止有效期很短的 token 半数不足 5 分钟)。所以"过半"的准确说法是:剩余时间 < max(5 分钟, 有效期 × ½) 就刷新。

3.3 设备码流程 —— OAuthManager.login 的完整流程(oauth-manager.ts:406-459),①-⑦ 标在代码里:

```ts
  async login(options: LoginOptions = {}): Promise<TokenInfo> {
    const startedAt = this.now();
    const deadlineAt = startedAt + Math.ceil(this.deviceCodeTimeoutMs / 1000);

    while (true) {                                          // ① 外层循环:一轮 = 一个新的待确认码
      const auth = await this.requestImpl(this.config);    // ② 向登录服务器要码 ← 就是这一句
      await options.onDeviceCode?.(auth);                  // ③ 把链接送回界面、打开浏览器

      let currentInterval = Math.max(auth.interval, 1);    //    服务器建议的询问间隔(秒)
      let deviceExpired = false;
      while (true) {                                        // ④ 内层循环:反复问"确认了吗"
        this.throwIfAborted(options.signal);
        if (this.now() >= deadlineAt) {
          throw new DeviceCodeTimeoutError(...);            //    整体超时,放弃
        }

        const result = await this.pollImpl(this.config, auth.deviceCode);   // ⑤ 问一次
        if (result.kind === 'success') {
          await this.storage.save(this.config.name, result.token);          // ⑥ 成功 → 落盘并返回
          return result.token;
        }
        if (result.kind === 'denied') {
          throw new OAuthAccessDeniedError(...);            //    你在浏览器里点了"拒绝"
        }
        if (result.kind === 'expired') {
          deviceExpired = true;                             //    码过期 → 跳出内层
          break;
        }
        if (result.errorCode === 'slow_down') {
          currentInterval += 5;                             //    服务器让慢点问:间隔永久 +5 秒
        }
        await this.sleep(currentInterval * 1000);           //    睡一会,回到 ④ 再问
      }
      if (!deviceExpired) break;
      if (this.now() >= deadlineAt) {
        throw new DeviceCodeTimeoutError('Device authorization timed out');
      }
    }                                                       // ⑦ deviceExpired → 回到 ① 重新要码
```

② 向登录服务器要码,发的是这个请求。完整调用链:主循环 `this.requestImpl(this.config)` 这一句 → `requestImpl` 这个字段在 OAuthManager 构造函数里赋值,默认赋值成"包一层调 requestDeviceAuthorization"(oauth-manager.ts:136-146):

```ts
    this.requestImpl =
      options.requestDeviceImpl ??
      ((config) =>
        requestDeviceAuthorization(config, {
          deviceHeaders: this.resolveDeviceHeaders(),
        }));
    this.pollImpl =
      options.pollDeviceImpl ??
      ((config, deviceCode) =>
        pollDeviceToken(config, deviceCode, {
          deviceHeaders: this.resolveDeviceHeaders(),
        }));
```

正常使用时没有谁会传 options.requestDeviceImpl,所以 `??` 总是取右边 —— 也就是说,这里赋值给 requestImpl 的,就是上面代码 `??` 右边那个箭头函数;

它被调用时只做一件事:拿到 config,补上 deviceHeaders 这个参数,然后去调 requestDeviceAuthorization。左边这个参数存在的意义,是让测试可以把它换成一个假的(不发网络请求,直接返回造好的数据)。

接下来看 requestDeviceAuthorization 内部干了什么:拼出 URL 并发出请求(packages/oauth/src/oauth.ts:119):

```ts
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/device_authorization`;
  const { status, data } = await postForm(
    url,
    { client_id: config.clientId },
    options.deviceHeaders,
  );
```

服务器返回六个字段(oauth.ts:153-160):userCode(短验证码)、deviceCode(程序轮询用的凭证)、verificationUri(不带验证码的链接,常是空串)、verificationUriComplete(自带验证码的链接)、expiresIn(码的有效秒数)、interval(建议的轮询间隔)—— ② 拿到的 `auth` 就是它们,③ 的回调把它送回界面。

userCode 什么时候用?正常路径打开的是 verificationUriComplete,验证码已经在链接里,你不用手输;只有浏览器没打开的兜底场景,才照着界面/终端上显示的 userCode 手动输入。TUI 就是这么做的 —— 打开链接的同时在界面上摆一个盒子,code 就是留给兜底用的(kimi-tui.ts:3256-3266):

```ts
  showLoginAuthorizationPrompt(auth: DeviceAuthorization): LoginProgressSpinnerHandle {
    openUrl(auth.verificationUriComplete);
    this.state.transcriptContainer.addChild(
      new DeviceCodeBoxComponent({
        title: 'Sign in to Kimi Code',
        url: auth.verificationUriComplete,
        code: auth.userCode,
        hint: 'Press Ctrl-C to cancel',
      }),
    );
```

⑤ 每次问"确认了吗",发的是这个请求(pollImpl —— 上面构造代码里默认赋值成的 pollDeviceToken,oauth.ts:168):

```ts
  const url = `${config.oauthHost.replace(/\/$/, '')}/api/oauth/token`;
  const { status, data } = await postForm(
    url,
    {
      client_id: config.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    options.deviceHeaders,
  );
```

⑥ 落盘的文件:`credentials/<槽位名>.json`(FileTokenStorage,storage.ts:41;权限 0600,只有你本人能读),内容 = `{ accessToken, refreshToken, expiresAt, scope, ... }`。

→ token到手,进入第 4 步:配置模型。

### 第 4 步:配置模型 —— 拉模型清单 + 写进配置文件

文件:packages/oauth/src/managed-kimi-code.ts、packages/node-sdk/src/auth.ts

4.0 配置模型做什么:把"这个环境有哪些模型可用"从服务器拉下来,写进 config.toml,这样程序才知道默认用哪个模型、每个模型的窗口多大。

4.1 入口(toolkit.ts:190-227):

```ts
    const shouldProvision = options.provisionConfig ?? this.configAdapter !== undefined;
    const configAdapter = this.configAdapter;
    let provision: ManagedKimiCodeProvisionResult | undefined;
    if (shouldProvision && configAdapter !== undefined) {
      const provisionWithToken = (token: string): Promise<ManagedKimiCodeProvisionResult> =>
        provisionManagedKimiCodeConfig({
          accessToken: token,
          adapter: configAdapter,
          baseUrl: options.baseUrl,
          oauthKey,
          oauthHost,
          preserveDefaultModel: hadToken,
          fetchImpl: this.fetchImpl,
          headers: this.identityHeaders(),
        });
      try {
        provision = await provisionWithToken(accessToken);
      } catch (error) {
        if (!(error instanceof OAuthUnauthorizedError) || !hadToken || usedDeviceLogin) {
          throw error;                              // 拉模型遇 401 且手里是旧token → 走兜底
        }
        let retryToken: string;
        try {
          retryToken = await manager.ensureFresh({ force: true });   // 先强制刷新
        } catch (refreshError) {
          if (!(refreshError instanceof OAuthUnauthorizedError)) throw refreshError;
          retryToken = await loginWithDevice();                      // 刷新也被拒 → 重走设备码
        }
        provision = await provisionWithToken(retryToken);            // 换新token重试一次
        ...
      }
    }
```

4.2 第 1 小步 · 拉模型清单(fetchManagedKimiCodeModels,managed-kimi-code.ts:489-527):

```ts
export async function fetchManagedKimiCodeModels(options): Promise<ManagedKimiCodeModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      ...parseKimiCodeCustomHeaders(),
      ...options.headers,
      Authorization: `Bearer ${options.accessToken}`,   // ← 刚拿到的 token 在这进场
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    ...
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new ManagedKimiCodeModelsAuthError({ ... });   // ← 4.1 兜底接的就是这个错
    }
    throw new Error(message);
  }
  const payload: unknown = await response.json();
  ...
  return payload['data'].map((item) => toModelInfo(item)).filter((item) => item !== undefined);
}
```

服务器回 `{ data: [...] }`,逐条解析成模型信息:id、展示名、上下文窗口大小、思考档位等。Bearer 是"请求头里放 token"的标准写法。

4.3 第 2 小步 · 读配置 —— 总调度其实就四行(provisionManagedKimiCodeConfig,managed-kimi-code.ts:840-858):

```ts
export async function provisionManagedKimiCodeConfig<TConfig>(options): Promise<ManagedKimiCodeProvisionResult> {
  const models = await fetchManagedKimiCodeModels(options);   // ← 4.2
  const config = await options.adapter.read();                // ← 4.3
  const applied = options.adapter.apply(config, {             // ← 4.4
    models, baseUrl: options.baseUrl, oauthKey: options.oauthKey, oauthHost: options.oauthHost,
    preserveDefaultModel: options.preserveDefaultModel,
  });
  await options.adapter.write(config);                        // ← 4.5
  return { providerName: KIMI_CODE_PROVIDER_NAME, defaultModel: applied.defaultModel, ... };
}
```

`adapter.read()` 读出的是**整份 config.toml 解析成的对象**,不是某个片段。adapter 的三个函数在 SDK 侧赋值(node-sdk/auth.ts:118-128)—— "严格读"的英文注释就贴在 read 那行上面:

```ts
      configAdapter: {
        configPath: options.configPath,
        // Write-path base read: strict (a salvaged base would drop the user's
        // broken-but-fixable sections on rewrite) with an actionable message.
        read: () => readConfigFileForUpdate(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
```

解析结果的形状(ManagedKimiCodeConfigShape,managed-kimi-code.ts:187)包含:

- a. providers —— 各 `[providers.<名字>]` 段(程序自己管的 + 用户自己加的);

- b. models —— 各 `[models.<别名>]` 段;

- c. defaultModel、thinking、services,以及用户手写的任何其他段(原样带过,不会动)。

为什么要绕这一道 adapter(适配器)?因为 oauth 这个包不认识 config.toml 的格式,所以 SDK 把"怎么读、怎么写"做成三个函数(read/apply/write)递给它 —— oauth 包只管"改什么",不管"文件长什么样"。"严格读"的原因:这份读出来的对象就是 4.5 要整份写回的底稿,读坏了会把用户配置写坏。

4.4 第 3 小步 · 在内存里改(applyManagedKimiCodeConfig,managed-kimi-code.ts:565 起,只改内存里的对象,不碰磁盘)。a、b 两件事的代码(:582-601):

```ts
  const baseUrl = defaultBaseUrl(options.baseUrl);
  const oauth =
    options.oauthKey !== undefined
      ? managedOAuthRef({ key: options.oauthKey, oauthHost: options.oauthHost })   // ← a. 生成 token 存放指引
      : resolveKimiCodeOAuthRef({ baseUrl, oauthHost: options.oauthHost });
  ...
  config.providers[KIMI_CODE_PROVIDER_NAME] = {   // ← b. 重写 [providers."managed:kimi-code"] 段
    type: 'kimi',
    baseUrl,
    apiKey: '',
    oauth,
  };
```

c. 合并模型清单(:604-628):

```ts
  const upstreamKeys = new Set(options.models.map((m) => managedModelKey(m.id)));
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === KIMI_CODE_PROVIDER_NAME && !upstreamKeys.has(key)) {
      delete existingModels[key];          // 先删:上次写过、服务器已下架的旧别名
    }
  }
  for (const model of options.models) {
    const key = managedModelKey(model.id);
    const existing = isRecord(existingModels[key]) ? existingModels[key] : {};
    existingModels[key] = mergeRefreshedModelAlias(   // 再 upsert(有就更新、没有就新增):
      existing,                                        // 上游字段以新值为准,用户字段保留
      toManagedModelAlias(KIMI_CODE_PROVIDER_NAME, model),
      MANAGED_KIMI_MODEL_FIELDS,
    );
  }
```

选默认模型的规则(selectDefaultModel,:736):如果是重新登录且旧默认还在线 → 不动,首次登录 → 取清单第一个。d. 写默认 + services(:622-641):

```ts
  config.models = existingModels;
  config.defaultModel = selectedDefault.modelKey;
  config.thinking = { ...config.thinking, enabled: selectedDefault.thinking };
  config.services = {
    moonshotSearch: { baseUrl: `${baseUrl}/search`, apiKey: '', oauth },   // 搜索/抓取共用同一个指引
    moonshotFetch: { baseUrl: `${baseUrl}/fetch`, apiKey: '', oauth },
  };
```

4.5 第 4 小步 · 整份写回 —— 就是 4.3 贴的 adapter 里那行 `write: async (config) => { await writeConfigFile(...) }`(node-sdk/auth.ts:123-125),把改完的对象原子写回 config.toml(原子 = 要么整份写成功、要么完全不写,不会写一半)。

→ 登录 + 配置模型到此完成,控制权回到 2.3。进入第 5 步看以后怎么用。

**到这里,登录流程完毕,可以开始会话了**:token 在凭据文件里、模型清单和默认模型在 config.toml 里,"用哪个模型、往哪个地址发、凭据去哪找"全部就绪。剩下的是各入口自己的收尾:

- VS Code:handler 在 login 成功后调 updateLoginContext(auth.handler.ts:25)→ 返回 success 给 webview → handleLoginSuccess → refresh()(App.tsx:86-90)→ useAppInit 重跑:loggedIn=true、模型数 > 0 → status "ready" → 进主界面。第 5 步是惰性的:发出第一条消息才第一次真正执行,每次请求现取 token、快过期现刷。

- TUI:refreshKimiRegion() + spinner 停在 "Logged in."(tui/commands/auth.ts:77-78),回到对话界面。

- CLI:打印登录结果(默认模型等),之后起会话时用。

**updateLoginContext 是什么**(apps/vscode/src/utils/context.ts:4-9)—— VS Code 入口收尾都要调它,一共 6 处:扩展激活(extension.ts:36)、CheckLoginStatus(auth.handler.ts:13)、登录成功(:25)、登录失败(:29)、登出成功(:43)、登出失败(:47)。代码就四行:

```ts
export async function updateLoginContext(harness: KimiHarness): Promise<boolean> {
  const status = await harness.auth.status();
  const loggedIn = status.providers.some((provider) => provider.hasToken);
  await vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
  return loggedIn;
}
```

逐行:

- `harness.auth.status()`:问总台"现在有哪些提供方、各自有没有 token" —— 只读凭据文件,不发网络(KimiAuthFacade.status,auth.ts:132-134);

- `providers.some(hasToken)`:任何一个提供方有 token 就算已登录;

- `setContext "kimi.isLoggedIn"`:设置一个 VS Code 上下文键(界面元素按登录状态显隐的开关)—— 设置之后的流程见下;

- 返回 loggedIn,调用方(CheckLoginStatus)把它作为结果带给 webview。

**setContext 设置之后发生什么**:

- VS Code 重新计算所有引用这个键的 `when` 条件 —— 宿主内置机制,不需要我们写任何代码;

- package.json 的 commandPalette 段(:200 起)里,`kimi.logout` 那条带着 `"when": "kimi.isLoggedIn"`(:233-236)—— 已登录时,Ctrl+Shift+P 命令面板里才出现 Kimi 的 Logout 命令;登出后键变 false,这条命令从面板里消失;

```json
        {
          "command": "kimi.logout",
          "when": "kimi.isLoggedIn"
        }
```

- 真去点这个命令的话,执行的只是个指路牌(extension.ts:123-126):聚焦 webview + 提示去设置里点登出 —— 真正的登出走 webview 设置里的按钮 → `Methods.Logout` RPC → `harness.auth.logout`:

```ts
    "kimi.logout": async () => {
      await vscode.commands.executeCommand("kimi.webview.focus");
      await vscode.window.showInformationMessage("Use the logout button in Kimi settings.");
    },
```

`kimi.webview.focus` 呢?它不是本仓库定义的命令,是 VS Code 的内置约定:每个注册了的 webview 视图,VS Code 自动生成一个 `<视图id>.focus` 命令。这个视图的 id 是 `kimi.webview` —— package.json:178-184 声明它住在 `kimi-sidebar` 容器里、名字叫 "Kimi Code";extension.ts:69 注册它的内容提供器:

```ts
    vscode.window.registerWebviewViewProvider("kimi.webview", provider, {
```

所以 `executeCommand("kimi.webview.focus")` 的效果是:把侧边栏切到 Kimi Code 面板并聚焦。登出指路牌里先调它,是为了把面板调到用户眼前、再弹提示"去设置里点登出" —— 不然用户可能找不到设置按钮在哪。全仓用它 4 处(extension.ts:101、:104、:113、:124),都是命令处理里"需要用户先看到 webview"的场景。

```
setContext kimi.isLoggedIn
  → when 条件重算(宿主内置)
  → 命令面板的 kimi.logout 项显隐(package.json:233-236)
      → 点它 = 指路牌:executeCommand("kimi.webview.focus") + 提示
          → kimi.webview.focus 又是什么:VS Code 对注册视图自动生成的
            <id>.focus 内置命令(id = kimi.webview,package.json:178-184
            声明、extension.ts:69 注册),效果 = 侧边栏切到 Kimi Code 面板并聚焦
      → 真正登出:webview 设置按钮 → Methods.Logout RPC → harness.auth.logout
```

### 第 5 步:以后每次请求,token从哪来(闭环)

5.1 你每次发消息,引擎要调模型前,都会通过 SDK 组装时递进来的 resolveOAuthTokenProvider 拿一个"取 token 的函数"(node-sdk/src/auth.ts:273-292):

```ts
  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    const provider = this.toolkit.tokenProvider(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
    return {
      getAccessToken: async (options) => {
        try {
          return await provider.getAccessToken(options);
        } catch (error) {
          // Classify OAuth token failures into the public KimiError protocol;
          // unrecognized errors are rethrown raw (see mapOAuthTokenError).
          throw mapOAuthTokenError(error, providerName) ?? error;
        }
      },
    };
  };
```

其中 `runtimeOAuthRef`(auth.ts:321-331)先读 config.toml 里 provider 段的 oauth 字段(用的就是第 2 步第 3 行那个 resolveManagedAuth),再交给核对函数:

```ts
  private runtimeOAuthRef(providerName, oauthRef): OAuthRef | undefined {
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    return resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: auth.baseUrl,
      configuredOAuthRef: oauthRef ?? auth.oauthRef,
    }).oauthRef;
  }
```

5.2 核对 token 存放指引(managed-kimi-code.ts:360-381):

```ts
export function resolveKimiCodeRuntimeAuth(options: {...}): ManagedKimiRuntimeAuth {
  const envBaseUrl = kimiCodeEnvBaseUrl(env);
  const envOAuthHost = kimiCodeEnvOAuthHost(env);
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const baseUrl = envBaseUrl !== undefined ? normalizeBaseUrl(envBaseUrl) : options.configuredBaseUrl;
  const expected = resolveKimiCodeOAuthRef({          // ← 现算一个期望指引
    oauthHost: hasEnvOverride ? envOAuthHost : options.configuredOAuthRef?.oauthHost,
    baseUrl,
  });
  const configured = configuredOAuthRef(options.configuredOAuthRef);
  if (configured === undefined) return { baseUrl, oauthRef: expected };
  if (hasEnvOverride) return { baseUrl, oauthRef: expected };      // 环境变量设了 → 以它为准
  if (configured.key !== expected.key) return { baseUrl, oauthRef: expected };  // config 是别的环境留下的 → 不用
  return { baseUrl, oauthRef: configured };                        // key 对得上 → 用配置里那份
}
```

核对用的 resolveKimiCodeOAuthRef 和登录时写指引用的是同一个函数,所以"登录时写进指引的 key,取 token 时算出来的一定还是它"。

5.3 按 token 存放指引找到凭据文件、读 token —— toolkit.tokenProvider(toolkit.ts:271-283):

```ts
  tokenProvider(providerName?, oauthRef?): BearerTokenProvider {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const oauthHost = this.oauthHostFor(oauthRef);
    const oauthKey = oauthRef?.key ?? this.defaultOAuthKey(undefined, oauthHost);
    return {
      getAccessToken: (options) => this.managerFor(name, oauthKey, oauthHost).ensureFresh(options),
    };                                              // ↑ managerFor 用同一个 key → 同一个凭据文件
  }
```

`ensureFresh` 内部(doEnsureFresh):先从 `credentials/<槽位名>.json` 读出 token;剩余时间充足直接返回;不足就走刷新分支(oauth-manager.ts:359-368):

```ts
      if (activeToken.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError(
          `Token for "${this.config.name}" has no refresh_token; re-login required.`,
        );
      }

      try {
        const refreshed = await this.refreshImpl(this.config, activeToken.refreshToken);
        await this.storage.save(this.config.name, refreshed);   // ← 新 token 写回同一个文件
        this.notifyRefresh({ success: true });
        return refreshed.accessToken;
```

"剩余时间充足还是不足"的判定就是 3.2 贴过的 shouldRefreshToken(剩余 < max(5 分钟, 有效期 × ½) 就刷)。

5.4 最后一跳:token 怎么变成请求头,分四段。

引擎侧的入口是 provider-manager(packages/agent-core/src/session/provider-manager.ts:182):OAuth 类型的 provider 每次要发请求,先拿"取 token 的函数"—— 就是 SDK 递进来的那个(sdk-rpc-client.ts:82-83):

```ts
      resolveOAuthTokenProvider:
        options.resolveOAuthTokenProvider ?? this.auth.resolveOAuthTokenProvider,
```

```ts
    const tokenProvider = this.options.resolveOAuthTokenProvider?.(providerName, providerConfig.oauth);
```

每次请求前取 token、包成 auth(provider-manager.ts:191-204):

```ts
    const fetchAuth = async (force: boolean): Promise<ProviderRequestAuth> => {
      let apiKey: string;
      try {
        apiKey = await tokenProvider.getAccessToken(force ? { force: true } : undefined);
      } catch (error) { ... }
      if (apiKey.trim().length === 0) throw loginRequired();
      return { apiKey };
    };
```

发请求时带着 auth,遇到 401 会强制刷新后重试一次(provider-manager.ts:206 起):

```ts
    return async (request) => {
      let auth = await fetchAuth(false);
      for (let refreshed = false; ; refreshed = true) {
        try {
          return await request(auth);
        ...
```

auth 最终到达 Kimi 的模型适配器(packages/kosong/src/providers/kimi.ts:639-652),token 作为 apiKey 交给 OpenAI 客户端:

```ts
  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, a?.headers);
        return new OpenAI({
          apiKey: requireProviderApiKey('KimiChatProvider', a, this._apiKey),
          baseURL: this._baseUrl,
          defaultHeaders,
        });
      },
    );
  }
```

真正写出 `Authorization: Bearer <token>` 这一行的是 openai 这个 npm 包的客户端(它对每个请求自动把 apiKey 放进这个头)—— 在 node_modules 里,不在本仓库。

### 第 6 步:专解 —— token 存放指引(oauth 字段)是什么、为什么

打个比方:游泳馆存包柜。token 是包;token 存放指引就相当于那张柜子号码牌 —— 按它找到柜子、取包。

6.1 token 存放指引的内容:`{ storage: 'file', key, oauthHost }`(managed-kimi-code.ts:282-291)—— 用文件存(storage)、柜子号是 key、游泳馆地址是 oauthHost。

6.2 key 怎么编号:官方默认环境 → 固定 `'oauth/kimi-code'`;自建/区域环境 → `'oauth/kimi-code-env-' + sha256({oauthHost, baseUrl}) 前 16 位` —— 相当于把"哪家馆"算成一个指纹当柜号(算法代码见 2.1 无覆盖分支里贴的 resolveKimiCodeOAuthKey,managed-kimi-code.ts:321-337)。

6.3 柜号(key)→ 文件名的映射:去掉 `'oauth/'` 前缀,剩下的就是文件名 —— `'oauth/kimi-code'` → `credentials/kimi-code.json`;`'oauth/kimi-code-env-<hash>'` → `credentials/kimi-code-env-<hash>.json`(另兼容老配置里的裸 `'kimi-code'`,同样落到 `kimi-code.json`),toolkit.ts:472-484:

```ts
  const key = input.oauthKey ?? KIMI_CODE_OAUTH_KEY;
  if (key === 'kimi-code' || key === KIMI_CODE_OAUTH_KEY) return 'kimi-code';

  const prefix = 'oauth/';
  if (key.startsWith(prefix) && key.slice(prefix.length).length > 0) {
    return key.slice(prefix.length);
  }
```

6.4 最关键的设计:存包时(登录,toolkit.ts:406)和取包时(每次请求,:271)用**同一个函数**算柜号,所以永远对得上。`:339-347` 注释原文:"the slot a token is written to always matches the slot it is later read from"(写进哪个槽,之后读的就是哪个槽)—— 防的就是换了环境之后拿错包。

### 第 7 步:登录后的 config.toml 长什么样(示意)

常量取自 managed-usage.ts:29 和 constants.ts:3,模型名用占位符。

```toml
defaultModel = "<首次登录取清单第一个>"
thinking = { enabled = true }

[providers."managed:kimi-code"]                # 4.4b 重写;段名带冒号,TOML 要求加引号;token不在这里
type = "kimi"
baseUrl = "https://api.kimi.com/coding/v1"
apiKey = ""
oauth = { storage = "file", key = "oauth/kimi-code", oauthHost = "https://auth.kimi.com" }

[models."<键名由 managedModelKey(id) 生成>"]     # 4.4c 合并进来的模型别名
provider = "kimi-code"
model = "<模型 id>"
maxContextSize = 262144
displayName = "<展示名>"

[services.moonshotSearch]                      # 4.4d:搜索/抓取共用同一个 token 存放指引
baseUrl = "https://api.kimi.com/coding/v1/search"
apiKey = ""
oauth = { storage = "file", key = "oauth/kimi-code", oauthHost = "https://auth.kimi.com" }
```

### 第 8 步:两个关键设计的原文

8.1 token与配置解耦 —— 配置里只存 token 存放指引,不存 token 本体(managed-kimi-code.ts:596-601):

```ts
config.providers[KIMI_CODE_PROVIDER_NAME] = {
  type: 'kimi',
  baseUrl,
  apiKey: '',
  oauth,        // ← { key, oauthHost } token 存放指引;token本体在 credentials/<槽位名>.json
};
```

8.2 adapter 三个函数 —— oauth 包不认识 config.toml,读写全由 SDK 递函数(node-sdk/src/auth.ts:118-128,toolkit 只看到 `adapter.read/apply/write` 三个函数)。

### 第 9 步:和 okta 版的对照

| 环节 | Kimi(本篇) | okta(这个仓库加的) |
|---|---|---|
| 拿token | 设备码轮询(oauth-manager.ts:406) | 授权码 + PKCE 回环/深链接(auth-provider.ts) |
| token存哪 | `credentials/<名>.json` 落盘,0600 | SecretStorage(VS Code 加密存储),**不落盘** |
| 拉模型 | `GET /models` + `applyManagedKimiCodeConfig` | `fetchOktaModels` + `applyOktaProviderConfig`(models.ts 注释声明沿用 Kimi 的规则) |
| 凭据进 config.toml | token 存放指引(oauth 字段)+ `apiKey: ''` | 整个 provider 行走内存层注入,`apiKey: ''` |

okta 的 `models.ts` 头注释里那句"归属规则沿用 `applyManagedKimiCodeConfig`(packages/oauth)"指的就是 4.4 里 `:565` 这个函数 —— 两边是同一套设计。
