/**
 * Okta IdP(身份提供方,这里就是 Okta)的配置,从 `<homeDir>/okta.json`
 * (默认 `~/.kimi-code/okta.json`)加载 —— 只管身份这一侧(issuer、client、
 * 端点、端口)。你自己的网关 API 放在旁边的 gateway.json 里。Okta 是默认登录
 * 模式;但有这个文件,Okta 登录才真正可用(没有它,登录页会提示先去创建)。
 * 设置 `"authMode": "kimi"` 可回退到内置的 Kimi 登录界面。
 *
 * 示例文件:
 * {
 *   "issuer": "https://example.okta.com",
 *   "clientId": "0oa1abcd2EFgHiJkLmN3",
 *   "redirectUri": "vscode://life-restver-rd.restver-code/callback",
 *   "scopes": "openid profile email offline_access",
 *   "authorizePath": "/v1/authorize",
 *   "tokenPath": "/v1/token",
 *   "callbackPorts": [35173, 35174, 35175],
 *   "redirectPath": "/callback",
 *   "loginTimeoutMs": 600000,
 *   "authMode": "okta"
 * }
 *
 * Okta 应用必须是强制 PKCE(S256;防止授权码被截走冒用的校验,机制见 pkce.ts)
 * 的 OIDC(OpenID Connect,基于 OAuth 的登录身份标准)应用,并为 `callbackPorts`
 * 里的每个端口注册 `http://localhost:<port><redirectPath>` 为回调 URI。访问令牌
 * 的存活时间至少要 ~10 分钟,扩展宿主的刷新定时器(令牌寿命 TTL 过半就刷新;
 * 定时器每 5 分钟检查一次)才能让注入引擎的凭据始终先于过期时间刷新。
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface OktaSsoConfig {
  /** IdP 的 base URL,授权/令牌端点以它拼接。 */
  readonly issuer: string;
  /** Okta 应用的 OIDC client id。 */
  readonly clientId: string;
  /**
   * 预注册的 vscode:// 深链接(vscode:// 开头的 URL,系统会转交 VS Code)回调:
   * 设置后,浏览器把授权码直接交给本扩展的 URI handler(VS Code 把这类 URL 转给
   * 扩展的入口),而不是回环服务器(临时开在本机接收登录回调的小服务器)。必须
   * 同时匹配扩展的 publisher.name 路由(vscode://<publisher>.<extension>/...)
   * 和 Okta 应用注册的回调 URI。未设置 → 使用回环服务器回调。
   */
  readonly redirectUri: string | undefined;
  /** 请求的 OAuth scope,空格分隔。 */
  readonly scopes: string;
  /** 授权端点路径,拼在 issuer 后。 */
  readonly authorizePath: string;
  /** 令牌端点路径,拼在 issuer 后。 */
  readonly tokenPath: string;
  /** 回环服务器依次尝试的本地端口。 */
  readonly callbackPorts: readonly number[];
  /** 回环服务器的回调路径。 */
  readonly redirectPath: string;
  /** 交互式登录的超时时间(毫秒)。 */
  readonly loginTimeoutMs: number;
  /** 登录界面选择:"okta"(默认)或内置 "kimi" 界面。 */
  readonly authMode: "okta" | "kimi";
}

export const OKTA_CONFIG_FILENAME = "okta.json";

// 各字段缺省值:okta.json 未提供时使用。
const DEFAULT_SCOPES = "openid profile email offline_access";
const DEFAULT_AUTHORIZE_PATH = "/v1/authorize";
const DEFAULT_TOKEN_PATH = "/v1/token";
const DEFAULT_CALLBACK_PORTS = [35173, 35174, 35175];
const DEFAULT_REDIRECT_PATH = "/callback";
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 按 homeDir 维度的缓存条目,mtime + size 用于失效判断。 */
interface ConfigCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly config: OktaSsoConfig | undefined;
}

/** homeDir → 缓存条目;文件未变化时避免重复读盘解析。 */
const configCache = new Map<string, ConfigCacheEntry>();

/** 返回 okta.json 的完整路径。 */
export function oktaConfigPath(homeDir: string): string {
  return join(homeDir, OKTA_CONFIG_FILENAME);
}

/** 清空配置缓存(测试用)。 */
export function clearOktaConfigCache(): void {
  configCache.clear();
}

/**
 * 供登录入口判定显示哪个登录界面用的轻量、无副作用检查。直接读取 okta.json
 * (由配置加载器做记忆化:文件没变就直接用上次的解析结果);绝不启动整个模块,
 * 也不需要先经过组装根拿到门面实例。出错时返回 `{ mode: "okta", error }`,
 * 让 Okta 页面展示错误 —— 无论哪种情况,Okta 都是默认模式。
 */
export function readOktaMode(homeDir: string): { mode: "okta" | "kimi"; error: string | null } {
  try {
    const config = loadOktaConfig(homeDir);
    if (config?.authMode === "kimi") return { mode: "kimi", error: null };
    if (config === undefined) {
      return {
        mode: "okta",
        error: "Okta SSO is not configured. Create ~/.kimi-code/okta.json (issuer, clientId) and gateway.json (apiBaseUrl) to enable it.",
      };
    }
    return { mode: "okta", error: null };
  } catch (error) {
    return { mode: "okta", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 加载 okta.json:文件不存在返回 undefined,存在但非法则抛错。
 * 以 (mtime, size) 做记忆化:文件的修改时间和大小都没变,就直接用上次的解析结果。
 */
export function loadOktaConfig(homeDir: string): OktaSsoConfig | undefined {
  const path = oktaConfigPath(homeDir);
  let mtimeMs = 0;
  let size = -1;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    configCache.delete(homeDir);
    return undefined;
  }
  const cached = configCache.get(homeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.config;
  }
  const config = parseOktaConfig(path);
  configCache.set(homeDir, { mtimeMs, size, config });
  return config;
}

/** 把 okta.json 里空格分隔的 scopes 字符串拆成数组。 */
export function oktaScopes(config: OktaSsoConfig): string[] {
  return config.scopes.split(/\s+/).filter((scope) => scope.length > 0);
}

/** 读取并解析 okta.json,应用各字段缺省值;校验失败抛出带路径的错误。 */
function parseOktaConfig(path: string): OktaSsoConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid Okta SSO config (${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid Okta SSO config (${path}): expected a JSON object.`);
  }
  const issuer = requireHttpsUrl(raw, "issuer", path);
  const clientId = requireNonEmptyString(raw, "clientId", path);
  const callbackPorts = Array.isArray(raw["callbackPorts"])
    ? raw["callbackPorts"].filter((port): port is number => Number.isInteger(port) && port > 0 && port < 65536)
    : [];
  return {
    issuer,
    clientId,
    redirectUri: typeof raw["redirectUri"] === "string" && raw["redirectUri"].trim().length > 0
      ? raw["redirectUri"].trim()
      : undefined,
    scopes: typeof raw["scopes"] === "string" && raw["scopes"].length > 0 ? raw["scopes"] : DEFAULT_SCOPES,
    authorizePath:
      typeof raw["authorizePath"] === "string" && raw["authorizePath"].startsWith("/")
        ? raw["authorizePath"]
        : DEFAULT_AUTHORIZE_PATH,
    tokenPath:
      typeof raw["tokenPath"] === "string" && raw["tokenPath"].startsWith("/")
        ? raw["tokenPath"]
        : DEFAULT_TOKEN_PATH,
    callbackPorts: callbackPorts.length > 0 ? callbackPorts : DEFAULT_CALLBACK_PORTS,
    redirectPath:
      typeof raw["redirectPath"] === "string" && raw["redirectPath"].startsWith("/")
        ? raw["redirectPath"]
        : DEFAULT_REDIRECT_PATH,
    loginTimeoutMs:
      typeof raw["loginTimeoutMs"] === "number" && Number.isInteger(raw["loginTimeoutMs"]) && raw["loginTimeoutMs"] > 0
        ? raw["loginTimeoutMs"]
        : DEFAULT_LOGIN_TIMEOUT_MS,
    authMode: parseAuthMode(raw, path),
  };
}

/** 解析 authMode:缺省 "okta",其他非法值抛错。 */
function parseAuthMode(raw: Record<string, unknown>, path: string): "okta" | "kimi" {
  const value = raw["authMode"];
  if (value === undefined) return "okta";
  if (value === "okta" || value === "kimi") return value;
  throw new Error(`Invalid Okta SSO config (${path}): "authMode" must be "okta" or "kimi" (got ${JSON.stringify(value)}).`);
}

/** 校验字段为非空字符串,返回 trim 后的值。 */
function requireNonEmptyString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** 校验字段为 https URL;仅回环主机(本地 mock IdP)容忍 http,并去掉结尾斜杠。 */
function requireHttpsUrl(record: Record<string, unknown>, field: string, path: string): string {
  const value = requireNonEmptyString(record, field, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must be a URL (got "${value}").`);
  }
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localHost)) {
    // 只有回环 issuer(本地 mock IdP,如 ai_api_backend/server.mjs)容忍 http;
    // 其余一律必须是 https。
    throw new Error(`Invalid Okta SSO config (${path}): "${field}" must use https (got "${value}").`);
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** 类型收窄:判定通过后,TS 在该分支里把 unknown 当普通对象使用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
