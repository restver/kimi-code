/**
 * Okta 能力门面 —— 形状对齐 SDK 侧的 KimiAuthFacade(packages/node-sdk/src/auth.ts):
 * 用例编排住这一层,handler 只注入 UI 回调 + 翻译错误。与 KimiAuthFacade 一样,
 * 协作对象在构造函数内部创建并持为私有(tokenStore、provider 对应它的私有
 * toolkit);组装根只暴露本门面,唯一例外是 `provider` —— VS Code 要求把
 * AuthenticationProvider 注册进环境(registerAuthenticationProvider /
 * registerUriHandler),组装根必须拿到这个集成句柄。
 *
 * 本文件不 import vscode:宿主能力以两种方式进入 —— provider 的
 * requestSession 方法(VS Code 认证通道的封装,住在 auth-provider —— vscode
 * 认证 API 的唯一居所)与 secrets 的结构化最小接口(vscode.SecretStorage
 * 结构上满足)。UI 回调(onLoginUrl)随每次 login 传入,与 Kimi 登录的
 * onDeviceCode 同一模式;持久回调(onSessionChanged)在构造时注入,对应
 * KimiAuthFacadeOptions.onRefresh。任一用例失败直接抛错,由调用方翻译。
 */
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { OktaAuthenticationProvider } from "./auth-provider";
import { loadGatewayConfig, type GatewayConfig } from "./gateway-config";
import { loadOktaConfig, oktaScopes, type OktaSsoConfig } from "./okta-config";
import { provisionOktaModels } from "./models";
import { OktaTokenStore, createEngineInjector, type OktaSecretStorage } from "./token-store";

export interface OktaAuthFacadeOptions {
  readonly harness: KimiHarness;
  /** 密钥存储(tokenStore 用它持久化会话);vscode.SecretStorage 结构上满足。 */
  readonly secrets: OktaSecretStorage;
  readonly log: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
  /** 会话被清空(登出)时触发;组装根用它向所有 webview 广播。 */
  readonly onSessionChanged?: (() => void) | undefined;
}

export interface OktaLoginOptions {
  /** 每次登录的 UI 回调:拿到授权 URL 后广播给 webview 作为兜底链接。 */
  readonly onLoginUrl?: ((url: string) => void) | undefined;
}

export interface OktaAuthStatus {
  readonly loggedIn: boolean;
  readonly providerNames: readonly string[];
}

export class OktaAuthFacade {
  private readonly harness: KimiHarness;
  private readonly tokenStore: OktaTokenStore;

  /** VS Code 集成句柄:仅供组装根注册进环境,用例一律走 login/logout/status。 */
  readonly provider: OktaAuthenticationProvider;

  constructor(options: OktaAuthFacadeOptions) {
    this.harness = options.harness;
    this.tokenStore = new OktaTokenStore({ secrets: options.secrets, logError: options.logError });
    this.provider = new OktaAuthenticationProvider({
      harness: options.harness,
      tokenStore: this.tokenStore,
      log: options.log,
      logError: options.logError,
    });
    // 引擎注入器在首次 save()/load() 之前接好:令牌刷新后自动同步进引擎内存层。
    this.tokenStore.setEngineInjector(createEngineInjector(options.harness));
    if (options.onSessionChanged !== undefined) {
      this.tokenStore.onClear(options.onSessionChanged);
    }
  }

  /**
   * 登录用例(对齐 KimiAuthFacade.login 的"登录 + 开通一步到位"):走 VS Code
   * 认证入口拿会话(所有登录入口汇聚到 provider,单飞复用)→ 拉模型目录写入
   * config.toml(开通)→ 把生成的 provider 行 + header 模板存进会话(这样刷新后
   * 的重新注入、以及重载后免配置恢复,都能完整重建内存层的行)。
   */
  async login(options: OktaLoginOptions = {}): Promise<void> {
    const config = this.requireOktaConfig();
    const gateway = this.requireGatewayConfig();
    this.provider.onLoginUrl = options.onLoginUrl;
    const scopes = oktaScopes(config);
    const session = await this.provider.requestSession(scopes);
    if (session === undefined) {
      throw new Error("Okta sign-in was not completed.");
    }
    const provisioned = await provisionOktaModels({
      harness: this.harness,
      gateway,
      accessToken: session.accessToken,
    });
    await this.tokenStore.updateProviders(provisioned.providerRows, gateway.tokenHeaders);
  }

  /** 登出用例:走 provider 的共享登出路径(webview 与 VS Code 账户头像同一入口)。 */
  async logout(): Promise<void> {
    await this.provider.removeSession();
  }

  /** 状态用例:从会话存储读登录态与已开通的 provider 名。 */
  async status(): Promise<OktaAuthStatus> {
    const stored = await this.tokenStore.load();
    return {
      loggedIn: (stored?.token.accessToken.length ?? 0) > 0,
      providerNames: Object.keys(stored?.providerRows ?? {}),
    };
  }

  /** 释放:停止刷新定时器,销毁 provider 的事件发射器。 */
  dispose(): void {
    this.tokenStore.stopRefreshTimer();
    this.provider.dispose();
  }

  /** 读取 okta.json(IdP 一侧配置);缺失时抛错。 */
  private requireOktaConfig(): OktaSsoConfig {
    const config = loadOktaConfig(this.harness.homeDir);
    if (config === undefined) {
      throw new Error("Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.");
    }
    return config;
  }

  /** 读取 gateway.json(自有网关 API 配置);缺失时抛错。 */
  private requireGatewayConfig(): GatewayConfig {
    const gateway = loadGatewayConfig(this.harness.homeDir);
    if (gateway === undefined) {
      throw new Error("The gateway is not configured. Create ~/.kimi-code/gateway.json (apiBaseUrl) to enable model provisioning.");
    }
    return gateway;
  }
}
