/**
 * Okta SSO 的 VS Code 身份认证提供器(授权码流程 + PKCE,RFC 7636:每次登录先
 * 生成一对随机密钥,challenge 发给 Okta、verifier 留到换令牌时出示,防止授权码
 * 被截走冒用)。webview 从不直连 Okta:它通过
 * `vscode.authentication.getSession(OKTA_PROVIDER_ID, ...)` 请求会话,请求会落到这里。
 *
 * 提供器在扩展激活时构建并注册,不读 okta.json —— 所有依赖配置的内容
 * (issuer、client id、端口)都在调用时惰性解析,激活流程不会因配置缺失 /
 * 非法而阻塞或失败。会话被请求后的流程:启动回环服务器(临时开在本机
 * 127.0.0.1 接收登录回调的小服务器)→ 经 `asExternalUri` 映射其 URI(远程
 * 工作区场景)→ 在系统浏览器打开 `${issuer}/v1/authorize` → IdP(身份提供方,
 * 即 Okta)携带 `code` + `state` 重定向回回环服务器 → 到 `${issuer}/v1/token`
 * 换取令牌 → 经 `OktaTokenStore` 持久化(SecretStorage + 引擎内存注入)→ 返回会话。
 *
 * `onLoginUrl` 由 bridge(连接 webview 与扩展宿主的通信层)的 handler 在每次
 * 交互式登录前赋值,让 webview 能把授权 URL 作为兜底链接展示。
 */
import * as vscode from "vscode";

import type { TokenInfo } from "@moonshot-ai/kimi-code-oauth";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { loadOktaConfig, type OktaSsoConfig } from "./okta-config";
import { createPkceChallenge, randomState } from "./pkce";
import { startLoopbackServer, type LoopbackCallbackResult } from "./loopback";
import { OktaTokenStore, needsRefresh, type StoredOktaSession } from "./token-store";

export const OKTA_PROVIDER_ID = "kimi-code-okta";
export const OKTA_PROVIDER_LABEL = "Okta SSO";

/** 刷新令牌被拒绝(过期 / 吊销):会话已失效,需要重新登录。 */
export class OktaRefreshExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OktaRefreshExpiredError";
  }
}

/** 令牌端点响应:解析后的令牌 + 账户标签。 */
interface OktaTokenResponse {
  readonly token: TokenInfo;
  readonly accountLabel: string;
}

export class OktaAuthenticationProvider implements vscode.AuthenticationProvider {
  /** 每次登录前由 handler 赋值的钩子,用于广播授权 URL。 */
  onLoginUrl: ((url: string) => void) | undefined;

  private readonly harness: KimiHarness;
  private readonly tokenStore: OktaTokenStore;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, error: unknown) => void;
  private readonly _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  /** 进行中的交互式登录(single-flight 复用)。 */
  private inFlightCreate: Promise<vscode.AuthenticationSession> | undefined;
  /** 等待中的 vscode:// 深链接回调:浏览器落到 vscode:// URL 时 VS Code 转交到这里,若某个登录流程正在等待则交给它。 */
  private pendingCallback: { readonly state: string; readonly resolve: (result: LoopbackCallbackResult) => void } | undefined;

  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(options: {
    readonly harness: KimiHarness;
    readonly tokenStore: OktaTokenStore;
    readonly log: (message: string) => void;
    readonly logError: (message: string, error: unknown) => void;
  }) {
    this.harness = options.harness;
    this.tokenStore = options.tokenStore;
    this.log = options.log;
    this.logError = options.logError;
  }

  /** 实现 vscode.AuthenticationProvider:返回已存储的会话(无令牌则视为未登录)。 */
  async getSessions(
    _scopes?: readonly string[],
  ): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.tokenStore.load();
    if (stored === undefined || stored.token.accessToken.length === 0) return [];
    return [this.toSession(stored)];
  }

  /** 实现 vscode.AuthenticationProvider:发起交互式登录(single-flight 复用进行中的流程)。 */
  async createSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    // 单飞(single-flight):第二个调用者(双击、第二个面板)加入已在进行的浏览器流程,而不是再开一个。
    this.inFlightCreate ??= this.runCreateSession(scopes).finally(() => {
      this.inFlightCreate = undefined;
    });
    return this.inFlightCreate;
  }

  /**
   * 彻底登出 —— webview(oktaLogout RPC)和 VS Code 账户头像(VS Code 会直接
   * 调用这里)两个入口都会走到。清除会话并移除开通出的模型 / provider 段,
   * 让 webview 重新初始化进登录界面,而不是一个坏掉的"就绪"状态。
   */
  async removeSession(): Promise<void> {
    const stored = await this.tokenStore.load();
    await this.tokenStore.clear();
    if (stored !== undefined) {
      for (const name of Object.keys(stored.providerRows)) {
        try {
          await this.harness.removeProvider(name);
        } catch (error) {
          this.logError(`Unable to remove the provisioned provider "${name}" on logout`, error);
        }
      }
      try {
        await this.harness.getConfig({ reload: true });
      } catch {
        // 尽力刷新配置;下次 getConfig 反正会重新加载。
      }
    }
    this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
  }

  /**
   * vscode:// 深链接回调(redirectUri 模式):Okta 把浏览器重定向到注册的
   * vscode:// URI,VS Code 把它路由到这里。state 不匹配(过期链接、另一个
   * 窗口)时直接忽略。
   */
  handleUri(uri: vscode.Uri): void {
    const pending = this.pendingCallback;
    if (pending === undefined) return;
    const params = new URLSearchParams(uri.query);
    const error = params.get("error");
    if (error !== null) {
      pending.resolve({ error: `Okta authorization failed: ${error}` });
      this.pendingCallback = undefined;
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (code !== null && state === pending.state) {
      pending.resolve({ code });
      this.pendingCallback = undefined;
    }
  }

  /**
   * 窗口重载后恢复上一次的登录 —— 不需要 okta.json:存储的会话自带恢复所需的
   * 一切(令牌 + provider 名)。把仍然有效的访问令牌重新注入引擎的内存配置
   * (新引擎进程里是空的);令牌剩余寿命不足一半则改为刷新(那条路径才需要
   * okta.json),
   * 配置可用时再启动刷新定时器。
   */
  async restoreOnActivation(): Promise<void> {
    try {
      const stored = await this.tokenStore.load();
      if (stored === undefined) return;
      const config = this.tryConfig();
      if (config === undefined) {
        // 已登录,但 okta.json 现在没了:注入手里还有的令牌,刷新留到下次登录。
        await this.tokenStore.injectNow(stored);
        this.log("Okta session restored without okta.json; token refresh is disabled until the next sign-in.");
        return;
      }
      if (stored.token.accessToken.length === 0 || needsRefresh(stored.token)) {
        // refresh() 会经 tokenStore.save() 持久化,保存时会顺带重新注入。
        await this.refresh();
      } else {
        await this.tokenStore.injectNow(stored);
      }
      this.startRefreshTimer();
      this.log(`Okta session restored (${stored.accountLabel})`);
    } catch (error) {
      // 刷新令牌被拒:会话已清,静默返回,让登录页接管。
      if (error instanceof OktaRefreshExpiredError) return;
      this.logError("Okta session restore failed", error);
    }
  }

  /** 启动定时刷新;过期登出只记日志,由登录页接管。 */
  startRefreshTimer(): void {
    this.tokenStore.startRefreshTimer(async () => {
      try {
        return await this.refresh();
      } catch (error) {
        if (error instanceof OktaRefreshExpiredError) {
          this.log(`Okta session expired: ${error.message}`);
        } else {
          this.logError("Okta token refresh failed", error);
        }
        return undefined;
      }
    });
  }

  /**
   * 用 refresh_token 授权刷新已存储的令牌。返回刷新后的会话(已持久化)。
   * 刷新令牌被拒绝时,先清空存储再抛出 `OktaRefreshExpiredError`。
   */
  async refresh(): Promise<StoredOktaSession> {
    const config = this.requireConfig();
    const stored = await this.tokenStore.load();
    if (stored === undefined || stored.token.refreshToken.length === 0) {
      await this.removeSession();
      throw new OktaRefreshExpiredError("No Okta refresh token available; sign in again.");
    }
    let response: OktaTokenResponse;
    try {
      response = await this.postToken(config, {
        grant_type: "refresh_token",
        refresh_token: stored.token.refreshToken,
        client_id: config.clientId,
      });
    } catch (error) {
      if (error instanceof OktaRefreshExpiredError) {
        await this.removeSession();
      }
      throw error;
    }
    const refreshed: StoredOktaSession = {
      token: response.token,
      // 刷新响应不带 id_token;沿用登录时解出的账户标签。
      accountLabel: stored.accountLabel,
      providerRows: stored.providerRows,
      tokenHeaders: stored.tokenHeaders,
    };
    await this.tokenStore.save(refreshed);
    this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
    return refreshed;
  }

  /** 释放事件发射器。 */
  dispose(): void {
    this._onDidChangeSessions.dispose();
  }

  /** 惰性配置:只有在流程真正需要时才读 okta.json,缺失时抛错。 */
  private requireConfig(): OktaSsoConfig {
    const config = this.tryConfig();
    if (config === undefined) {
      throw new Error("Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.");
    }
    return config;
  }

  /** 读取并校验 okta.json;非法时记日志并返回 undefined。 */
  private tryConfig(): OktaSsoConfig | undefined {
    try {
      return loadOktaConfig(this.harness.homeDir);
    } catch (error) {
      this.logError("Okta SSO configuration is invalid", error);
      return undefined;
    }
  }

  /** 交互式登录主流程:构造授权请求、等待回调、换令牌并持久化。 */
  private async runCreateSession(scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
    const config = this.requireConfig();
    const state = randomState();
    const { verifier, challenge } = createPkceChallenge();
    // 两种回调通道,产出同一个 {code | error} 结果:预注册的 vscode:// 深链接
    // (浏览器把授权码交给我们的 URI handler),或默认的 127.0.0.1 回环服务器。
    let redirectUri: string;
    let callback: Promise<LoopbackCallbackResult>;
    let finish: () => void;
    if (config.redirectUri !== undefined) {
      redirectUri = config.redirectUri;
      callback = new Promise<LoopbackCallbackResult>((resolve) => {
        this.pendingCallback = { state, resolve };
      });
      finish = () => {
        this.pendingCallback = undefined;
      };
    } else {
      const server = await startLoopbackServer({
        ports: config.callbackPorts,
        redirectPath: config.redirectPath,
        state,
      });
      redirectUri = server.redirectUri;
      callback = server.callback;
      finish = () => {
        server.dispose();
      };
      try {
        // 远程工作区:把回环 URI 映射成端口转发后的外部地址。
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(server.redirectUri));
        if (external.scheme === "http" || external.scheme === "https") {
          redirectUri = external.toString();
        }
      } catch (error) {
        // 本地桌面不映射也能工作;远程只是丢掉端口转发(远程开发时把本机端口
        // 映射出去的机制)、大概率失败 —— 记日志继续。
        this.log(
          `Okta callback URI mapping unavailable, using ${redirectUri}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      // 拼接授权 URL:授权码模式 + PKCE(S256)+ state(随机串,回调时核对以防伪造)。
      const authorizeUrl = new URL(`${config.issuer}${config.authorizePath}`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", config.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", scopes.join(" "));
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      this.onLoginUrl?.(authorizeUrl.toString());
      // 在系统浏览器打开授权页(同时把 URL 交给 webview 作为兜底链接)。
      await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl.toString()));

      // 等待回调,带超时。
      const result = await raceWithTimeout(callback, config.loginTimeoutMs, () =>
        new Error(`Okta sign-in timed out after ${Math.ceil(config.loginTimeoutMs / 1000)}s`),
      );
      if ("error" in result) throw new Error(result.error);

      const response = await this.postToken(config, {
        grant_type: "authorization_code",
        code: result.code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: verifier,
      });
      const session: StoredOktaSession = {
        token: response.token,
        accountLabel: response.accountLabel,
        // 由 handler 在开通流程算出 provider 行后立刻回填;这里刻意留空。
        providerRows: {},
        tokenHeaders: {},
      };
      await this.tokenStore.save(session);
      this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] });
      this.log(`Okta SSO signed in (${session.accountLabel})`);
      return this.toSession(session);
    } finally {
      finish();
    }
  }

  /** 向令牌端点发 POST(authorization_code / refresh_token 两种授权),解析并校验响应。 */
  private async postToken(config: OktaSsoConfig, params: Record<string, string>): Promise<OktaTokenResponse> {
    const url = `${config.issuer}${config.tokenPath}`;
    const body = new URLSearchParams(params).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`Okta token request to ${url} failed: ${describeFetchFailure(error)}`, { cause: error });
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const errorCode = isRecord(payload) && typeof payload["error"] === "string" ? payload["error"] : undefined;
      // 400 / invalid_grant:凭据被拒(刷新令牌过期或吊销)。
      if (response.status === 400 || errorCode === "invalid_grant") {
        throw new OktaRefreshExpiredError(
          `Okta rejected the credentials (${errorCode ?? `HTTP ${response.status}`}); sign in again.`,
        );
      }
      throw new Error(`Okta token endpoint failed (HTTP ${response.status}): ${errorCode ?? "unknown error"}`);
    }
    if (!isRecord(payload) || typeof payload["access_token"] !== "string" || payload["access_token"].length === 0) {
      throw new Error(`Okta token response from ${url} is missing access_token.`);
    }
    // expires_in 缺失或非法时按 1 小时兜底。
    const expiresInRaw = Number(payload["expires_in"]);
    const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 3600;
    const token: TokenInfo = {
      accessToken: payload["access_token"],
      refreshToken: typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : "",
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      scope: typeof payload["scope"] === "string" ? payload["scope"] : "",
      tokenType: typeof payload["token_type"] === "string" ? payload["token_type"] : "Bearer",
      expiresIn,
    };
    return { token, accountLabel: accountLabelFromIdToken(payload["id_token"]) };
  }

  /** 把存储的会话映射成 VS Code 的 AuthenticationSession(单账户)。 */
  private toSession(stored: StoredOktaSession): vscode.AuthenticationSession {
    return {
      id: "okta-sso",
      accessToken: stored.token.accessToken,
      account: { id: "okta-sso", label: stored.accountLabel },
      scopes: stored.token.scope.split(/\s+/).filter((scope) => scope.length > 0),
    };
  }
}

/** 从 id_token 的 payload 解出展示用标签:email > preferred_username > 通用标签。 */
function accountLabelFromIdToken(idToken: unknown): string {
  if (typeof idToken !== "string" || idToken.length === 0) return OKTA_PROVIDER_LABEL;
  try {
    const payloadSegment = idToken.split(".")[1] ?? "";
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf-8");
    const payload: unknown = JSON.parse(decoded);
    if (!isRecord(payload)) return OKTA_PROVIDER_LABEL;
    // 仅作展示 —— 绝不用于授权判断。
    const email = payload["email"];
    if (typeof email === "string" && email.length > 0) return email;
    const username = payload["preferred_username"];
    if (typeof username === "string" && username.length > 0) return username;
  } catch {
    // id_token 畸形:回退到通用标签。
  }
  return OKTA_PROVIDER_LABEL;
}

/** 给 Promise 套一层超时:到时未完成则以 createError() 生成的错误 reject。 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(createError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 把错误连同 cause 链(嵌套在 error.cause 里的底层错误)拼成可读描述,去重后用 ": " 连接。 */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const messages: string[] = [];
  let current: Error | undefined = error;
  while (current !== undefined) {
    messages.push(current.message);
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return [...new Set(messages)].join(": ");
}

/** 类型收窄:判定通过后,TS 在该分支里把 unknown 当普通对象使用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
