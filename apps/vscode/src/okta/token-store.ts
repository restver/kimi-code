/**
 * Okta 会话存储:VS Code SecretStorage 是唯一的存储层 —— 完整会话(访问 /
 * 刷新令牌、账户标签、provider 名)的唯一事实来源,由 VS Code 加密。
 * 刷新令牌永远不离开这一层。
 *
 * 存储的会话刻意做成自包含:窗口重载后恢复它(全新引擎进程、内存层为空)时
 * 不需要 okta.json 的任何东西 —— provider 名和令牌一起从 secret 里取出,
 * 引擎通过 `setMemoryConfig` 拿到访问令牌。任何内容都不会写进
 * `<homeDir>/credentials/` 或 config.toml:令牌只存在于 secret 存储和引擎进程
 * 内存中,引擎每次重启后都必须重新注入(由 provider 的 `restoreOnActivation`
 * 完成),每次刷新后也会自动推送(save() 会顺带注入)。
 */
import type { TokenInfo } from "@moonshot-ai/kimi-code-oauth";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

/**
 * SecretStorage 的结构化最小接口(实际只用到 get/store/delete 三件事):
 * vscode.SecretStorage 结构上满足本接口 —— 声明在这里后,门面与组装根都不必 import vscode。
 */
export interface OktaSecretStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** 固定的 secret key —— 不从配置派生,恢复会话时才不用读 okta.json。 */
export const OKTA_SECRET_KEY = "kimi-code.okta";

/** 生成的 config.toml provider 行(不含 apiKey)。 */
export interface ProviderRow {
  /** 推理协议,对应 provider 段的 type。 */
  readonly type: string;
  /** 推理端点,对应 provider 段的 baseUrl。 */
  readonly baseUrl: string;
  /** 附加请求头(静态 + 渲染后的令牌模板头)。 */
  readonly customHeaders?: Readonly<Record<string, string>>;
}

/** SecretStorage 里持久化的完整 Okta 会话。 */
export interface StoredOktaSession {
  /** 令牌信息(访问 / 刷新令牌、过期时间等)。 */
  readonly token: TokenInfo;
  /** 展示用的账户标签(邮箱或用户名)。 */
  readonly accountLabel: string;
  /**
   * 完整的生成 provider 行(不含 apiKey):引擎写入内存配置层的 providers 时是
   * 整个区域一起替换、不是和磁盘配置逐字段合并,所以注入的行必须自带
   * type/baseUrl/customHeaders —— 一个只有 {apiKey} 的行会把 provider 自身的
   * 字段遮蔽掉,导致请求被重定向到厂商默认端点。
   */
  readonly providerRows: Readonly<Record<string, ProviderRow>>;
  /** 由令牌派生的 header 模板({token} 占位符),来自 gateway.json。 */
  readonly tokenHeaders: Readonly<Record<string, string>>;
}

/**
 * 访问令牌注入引擎的出口,建立在
 * `harness.setMemoryConfig({ providers: { [name]: { apiKey } } })` 和
 * `harness.clearMemoryConfig(["providers"])` 之上 —— 只走引擎的内存配置层,
 * 绝不写进任何磁盘文件。provider 名随每次调用传入:它在登录时被保存进存储的
 * 会话里,而不依赖 okta.json。
 */
export interface OktaEngineInjector {
  inject(
    accessToken: string,
    providerRows: Readonly<Record<string, ProviderRow>>,
    tokenHeaders: Readonly<Record<string, string>>,
  ): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 构造基于 harness 内存配置层的注入器:先把 {token} 模板渲染成真实 header,
 * 再为每个 provider 行组装完整的 type/baseUrl/apiKey/customHeaders 并整体写入。
 */
export function createEngineInjector(harness: KimiHarness): OktaEngineInjector {
  return {
    inject: (accessToken, providerRows, tokenHeaders) => {
      const providers: Record<string, Record<string, unknown>> = {};
      // 渲染令牌模板 header:{token} → 当前访问令牌。
      const renderedTokenHeaders: Record<string, string> = {};
      for (const [name, template] of Object.entries(tokenHeaders)) {
        renderedTokenHeaders[name] = template.replaceAll("{token}", accessToken);
      }
      // 内存层是整域替换,每个 provider 行必须自带全部字段。
      for (const [name, row] of Object.entries(providerRows)) {
        providers[name] = {
          type: row.type,
          baseUrl: row.baseUrl,
          apiKey: accessToken,
          customHeaders: {
            ...row.customHeaders,
            ...renderedTokenHeaders,
          },
        };
      }
      return harness.setMemoryConfig({ providers });
    },
    clear: () => harness.clearMemoryConfig(["providers"]),
  };
}

/** 刷新定时器的固定周期:每 5 分钟触发一次检查。 */
export const OKTA_REFRESH_TICK_MS = 5 * 60 * 1000;

/** Okta 会话的持久化 + 引擎注入 + 定时刷新。 */
export class OktaTokenStore {
  private readonly secrets: OktaSecretStorage;
  private readonly logError: (message: string, error: unknown) => void;
  /** 会话变化监听器(save / clear 都会触发)。 */
  private readonly listeners = new Set<() => void>();
  /** 仅登出(clear)监听器。 */
  private readonly clearListeners = new Set<() => void>();
  private engineInjector: OktaEngineInjector | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** single-flight 标记:同一时刻只允许一次刷新在跑,防止重叠的定时触发同时去请求令牌端点。 */
  private refreshInFlight: boolean = false;

  constructor(options: {
    readonly secrets: OktaSecretStorage;
    readonly logError: (message: string, error: unknown) => void;
  }) {
    this.secrets = options.secrets;
    this.logError = options.logError;
  }

  /** 接上引擎侧的注入器;需在首次 save()/load() 之前调用。 */
  setEngineInjector(injector: OktaEngineInjector | undefined): void {
    this.engineInjector = injector;
  }

  /** 把仍然有效的会话直接推给引擎(激活后的重启路径)。 */
  async injectNow(session: StoredOktaSession): Promise<void> {
    await this.injectToEngine(session);
  }

  /** 读取存储的会话;不存在或结构损坏时返回 undefined。 */
  async load(): Promise<StoredOktaSession | undefined> {
    return this.loadSecret();
  }

  /** 登录后记录开通出的 provider 行 + header 模板,并重新注入引擎。 */
  async updateProviders(
    providerRows: Readonly<Record<string, ProviderRow>>,
    tokenHeaders: Readonly<Record<string, string>>,
  ): Promise<void> {
    const session = await this.loadSecret();
    if (session === undefined) return;
    await this.save({ ...session, providerRows, tokenHeaders });
  }

  /** 持久化会话到 secret,立即注入引擎并通知变化监听器。 */
  async save(session: StoredOktaSession): Promise<void> {
    await this.secrets.store(OKTA_SECRET_KEY, JSON.stringify(session));
    await this.injectToEngine(session);
    this.notify();
  }

  /** 删除会话:清 secret、清引擎内存层,并通知变化 / 登出监听器。 */
  async clear(): Promise<void> {
    await this.secrets.delete(OKTA_SECRET_KEY);
    if (this.engineInjector !== undefined) {
      try {
        await this.engineInjector.clear();
      } catch (error) {
        this.logError("Unable to clear the in-engine Okta token", error);
      }
    }
    this.notify();
    for (const listener of this.clearListeners) {
      try {
        listener();
      } catch {
        // 观察者不得影响存储本身。
      }
    }
  }

  /** 订阅会话变化(save / clear);返回取消订阅函数。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 仅在登出(clear)时触发 —— 令牌轮换(刷新换新)不触发。 */
  onClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => {
      this.clearListeners.delete(listener);
    };
  }

  /**
   * 令牌剩余寿命不足一半就刷新(用刷新令牌主动换新,即 token rotation 轮换)。
   * 按固定周期运行;single-flight 保证同一时刻只有一次刷新在跑,重叠的定时触发
   * 不会同时请求令牌端点。`refresh` 回调返回刷新后的会话(由其调用方契约保证
   * 已持久化:返回给这里后由存储保存),返回 undefined 则维持原状;抛出的错误只
   * 记日志,不向上传播。
   */
  startRefreshTimer(refresh: () => Promise<StoredOktaSession | undefined>): void {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => {
      void this.tick(refresh);
    }, OKTA_REFRESH_TICK_MS);
  }

  /** 停止刷新定时器。 */
  stopRefreshTimer(): void {
    if (this.refreshTimer === undefined) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async injectToEngine(session: StoredOktaSession): Promise<void> {
    if (this.engineInjector === undefined || session.token.accessToken.length === 0) return;
    try {
      await this.engineInjector.inject(session.token.accessToken, session.providerRows, session.tokenHeaders);
    } catch (error) {
      // 注入失败只影响引擎侧请求(会带不上令牌),不影响登录本身;下次 save/refresh 会重试推送。
      this.logError("Unable to inject the Okta token into the engine", error);
    }
  }

  /** 单次定时检查:令牌未到期直接返回;同一时刻只跑一次刷新,执行回调并保存结果。 */
  private async tick(refresh: () => Promise<StoredOktaSession | undefined>): Promise<void> {
    if (this.refreshInFlight) return;
    const session = await this.loadSecret();
    if (session === undefined || !needsRefresh(session.token)) return;
    this.refreshInFlight = true;
    try {
      const refreshed = await refresh();
      if (refreshed !== undefined) await this.save(refreshed);
    } catch (error) {
      this.logError("Okta token refresh failed", error);
    } finally {
      this.refreshInFlight = false;
    }
  }

  /** 从 SecretStorage 读取并校验会话结构;损坏时视为不存在。 */
  private async loadSecret(): Promise<StoredOktaSession | undefined> {
    const raw = await this.secrets.get(OKTA_SECRET_KEY);
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredSession(parsed)) return undefined;
      return {
        token: parsed.token,
        accountLabel: parsed.accountLabel,
        providerRows: parsed.providerRows,
        tokenHeaders: parsed.tokenHeaders,
      };
    } catch {
      return undefined;
    }
  }

  /** 逐个触发变化监听器(异常不外抛)。 */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 观察者不得影响存储本身。
      }
    }
  }
}

/** 判断令牌剩余寿命是否不足一半:剩余时间 ≤ 生命周期的一半,即需要刷新。 */
export function needsRefresh(token: TokenInfo, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const lifetime = token.expiresIn > 0 ? token.expiresIn : 3600;
  return token.expiresAt - nowSec <= Math.floor(lifetime / 2);
}

/** 运行时校验 unknown 是否为结构完整的 StoredOktaSession。 */
function isStoredSession(value: unknown): value is StoredOktaSession {
  if (typeof value !== "object" || value === null) return false;
  const token = (value as { token?: unknown }).token;
  const providerRows = (value as { providerRows?: unknown }).providerRows;
  const tokenHeaders = (value as { tokenHeaders?: unknown }).tokenHeaders;
  return (
    typeof token === "object" &&
    token !== null &&
    typeof (token as { accessToken?: unknown }).accessToken === "string" &&
    typeof (value as { accountLabel?: unknown }).accountLabel === "string" &&
    typeof providerRows === "object" &&
    providerRows !== null &&
    typeof tokenHeaders === "object" &&
    tokenHeaders !== null
  );
}
