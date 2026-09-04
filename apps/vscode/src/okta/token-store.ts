/**
 * Okta session storage: VS Code SecretStorage is the ONLY tier — source of
 * truth for the full session (access + refresh token, account label, provider
 * name), encrypted by VS Code. The refresh token never leaves this tier.
 *
 * The stored session is self-contained on purpose: restoring it after a
 * window reload (fresh engine process, empty memory layer) needs NOTHING
 * from okta.json — provider name and token come out of the secret together,
 * and the engine gets the access token through `setMemoryConfig`. Nothing is
 * ever written to `<homeDir>/credentials/` or config.toml: the token exists
 * only in the secret store and in engine process memory, and must be
 * re-injected after every engine restart (the provider's
 * `restoreOnActivation` does this) and after every refresh (save() pushes it
 * automatically).
 */
import type { TokenInfo } from "@moonshot-ai/kimi-code-oauth";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";
import type * as vscode from "vscode";

/** Fixed secret key — no config derivation, so restore never reads okta.json. */
export const OKTA_SECRET_KEY = "kimi-code.okta";

export interface ProviderRow {
  readonly type: string;
  readonly baseUrl: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface StoredOktaSession {
  readonly token: TokenInfo;
  readonly accountLabel: string;
  /**
   * COMPLETE generated provider rows (minus the apiKey): the engine's memory
   * layer REPLACES a whole config domain rather than merging fields, so the
   * injected row must carry type/baseUrl/customHeaders itself — a bare
   * {apiKey} row would shadow the provider's own fields and redirect
   * requests to the vendor default endpoint.
   */
  readonly providerRows: Readonly<Record<string, ProviderRow>>;
  /** Token-derived header templates ({token} placeholder), from gateway.json. */
  readonly tokenHeaders: Readonly<Record<string, string>>;
}

/**
 * Engine-side sink for the access token, built on
 * `harness.setMemoryConfig({ providers: { [name]: { apiKey } } })` and
 * `harness.clearMemoryConfig(["providers"])` — the engine's in-memory
 * config layer, never the disk. The provider name arrives per call: it is
 * snapshotted in the stored session, not in okta.json.
 */
export interface OktaEngineInjector {
  inject(
    accessToken: string,
    providerRows: Readonly<Record<string, ProviderRow>>,
    tokenHeaders: Readonly<Record<string, string>>,
  ): Promise<void>;
  clear(): Promise<void>;
}

export function createEngineInjector(harness: KimiHarness): OktaEngineInjector {
  return {
    inject: (accessToken, providerRows, tokenHeaders) => {
      const providers: Record<string, Record<string, unknown>> = {};
      const renderedTokenHeaders: Record<string, string> = {};
      for (const [name, template] of Object.entries(tokenHeaders)) {
        renderedTokenHeaders[name] = template.replaceAll("{token}", accessToken);
      }
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

export const OKTA_REFRESH_TICK_MS = 5 * 60 * 1000;

export class OktaTokenStore {
  private readonly secrets: vscode.SecretStorage;
  private readonly logError: (message: string, error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private readonly clearListeners = new Set<() => void>();
  private engineInjector: OktaEngineInjector | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshInFlight: boolean = false;

  constructor(options: {
    readonly secrets: vscode.SecretStorage;
    readonly logError: (message: string, error: unknown) => void;
  }) {
    this.secrets = options.secrets;
    this.logError = options.logError;
  }

  /** Wire the engine-side sink; call before the first save()/load(). */
  setEngineInjector(injector: OktaEngineInjector | undefined): void {
    this.engineInjector = injector;
  }

  /** Push a still-valid session to the engine (activation restart path). */
  async injectNow(session: StoredOktaSession): Promise<void> {
    await this.injectToEngine(session);
  }

  async load(): Promise<StoredOktaSession | undefined> {
    return this.loadSecret();
  }

  /** Record the provisioned provider rows + header templates (post-login) and re-inject. */
  async updateProviders(
    providerRows: Readonly<Record<string, ProviderRow>>,
    tokenHeaders: Readonly<Record<string, string>>,
  ): Promise<void> {
    const session = await this.loadSecret();
    if (session === undefined) return;
    await this.save({ ...session, providerRows, tokenHeaders });
  }

  async save(session: StoredOktaSession): Promise<void> {
    await this.secrets.store(OKTA_SECRET_KEY, JSON.stringify(session));
    await this.injectToEngine(session);
    this.notify();
  }

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
        // Observers must not affect the store.
      }
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fires on logout (clear) only — not on token rotation. */
  onClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => {
      this.clearListeners.delete(listener);
    };
  }

  /**
   * Refresh fires when the token is past half its lifetime (RFC-style
   * proactive rotation). Runs on a fixed tick; single-flight so overlapping
   * ticks cannot stampede the token endpoint. The `refresh` callback returns
   * the refreshed session (already persisted by its caller contract: return
   * it here and the store saves it), or undefined to leave things as they
   * were; thrown errors are logged, not propagated.
   */
  startRefreshTimer(refresh: () => Promise<StoredOktaSession | undefined>): void {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => {
      void this.tick(refresh);
    }, OKTA_REFRESH_TICK_MS);
  }

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
      // Injection failures degrade engine requests, not login itself; the
      // next save/refresh retries the push.
      this.logError("Unable to inject the Okta token into the engine", error);
    }
  }

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

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Observers must not affect the store.
      }
    }
  }
}

export function needsRefresh(token: TokenInfo, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  const lifetime = token.expiresIn > 0 ? token.expiresIn : 3600;
  return token.expiresAt - nowSec <= Math.floor(lifetime / 2);
}

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
