/**
 * 网关配置,从 `<homeDir>/gateway.json`(默认 `~/.kimi-code/gateway.json`)加载。
 * 网关是你自己的 API —— Okta 只负责签发身份令牌。这个文件只描述模型目录
 * (从哪里拉取列表):目录里的每个条目自带推理端点(apiBase)和协议,所以这里
 * 不出现任何推理 URL。与 okta.json 刻意分开:IdP(身份提供方,即 Okta)和网关
 * 由不同的人管理,变更节奏也不同。
 *
 * 示例文件:
 * {
 *   "modelsBaseUrl": "https://api.example.internal",
 *   "modelsPath": "/models",
 *   "providerName": "okta",
 *   "defaultContextLength": 128000,
 *   "protocolAliases": { "openai": "openai_responses", "openrouter": "openai_responses" },
 *   "headers": { "version": "1.1.1", "name": "agent" },
 *   "tokenHeaders": { "apiKey": "{token}", "X-Agent": "agent-{token}" }
 * }
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface GatewayConfig {
  /** 模型目录的 base URL(GET {modelsBaseUrl}{modelsPath})。 */
  readonly modelsBaseUrl: string;
  /** 模型目录接口的路径,拼在 modelsBaseUrl 后。 */
  readonly modelsPath: string;
  /** 生成的 config.toml provider 段名前缀。 */
  readonly providerName: string;
  /** 目录条目未声明 contextLength 时的兜底窗口大小。 */
  readonly defaultContextLength: number;
  /** 随每个推理请求原样发送的静态 header。 */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * 由令牌派生的 header:header 名 → 值模板。注入时会把模板里的 `{token}`
   * 替换为当前的 Okta 访问令牌("{token}"、"Bearer {token}"、"agent-{token}" 等)。
   * 渲染结果只存在于引擎的内存配置层(引擎进程内存里的配置,重启即失),绝不
   * 写进任何磁盘文件,且每次令牌刷新后自动重新渲染。
   */
  readonly tokenHeaders: Readonly<Record<string, string>>;
  /**
   * 目录标签 → 实际推理协议,用于 "provider" 标签写的是厂商名而非线上协议的
   * 网关(例如全部标成 "openai" / "openrouter",实际走 Responses API)。
   * 这是唯一的映射来源 —— 代码里不做任何猜测。解析目录时会校验值是否属于
   * 支持的协议集合。
   */
  readonly protocolAliases: Readonly<Record<string, string>>;
}

export const GATEWAY_CONFIG_FILENAME = "gateway.json";

// 各字段缺省值:gateway.json 未提供时使用。
const DEFAULT_MODELS_PATH = "/models";
export const DEFAULT_GATEWAY_PROVIDER_NAME = "okta";
const DEFAULT_CONTEXT_LENGTH = 128000;
const EMPTY_PROTOCOL_ALIASES: Readonly<Record<string, string>> = {};
const EMPTY_HEADERS: Readonly<Record<string, string>> = {};

/** 按 homeDir 维度的缓存条目,mtime + size 用于失效判断。 */
interface GatewayCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly config: GatewayConfig | undefined;
}

/** homeDir → 缓存条目;文件未变化时避免重复读盘解析。 */
const gatewayCache = new Map<string, GatewayCacheEntry>();

/** 返回 gateway.json 的完整路径。 */
export function gatewayConfigPath(homeDir: string): string {
  return join(homeDir, GATEWAY_CONFIG_FILENAME);
}

/** 清空配置缓存(测试用)。 */
export function clearGatewayConfigCache(): void {
  gatewayCache.clear();
}

/**
 * 加载 gateway.json:文件不存在返回 undefined,存在但非法则抛错。
 * 以 (mtime, size) 做记忆化:文件的修改时间和大小都没变,就直接用上次的解析结果。
 */
export function loadGatewayConfig(homeDir: string): GatewayConfig | undefined {
  const path = gatewayConfigPath(homeDir);
  let mtimeMs = 0;
  let size = -1;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    gatewayCache.delete(homeDir);
    return undefined;
  }
  const cached = gatewayCache.get(homeDir);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.config;
  }
  const config = parseGatewayConfig(path);
  gatewayCache.set(homeDir, { mtimeMs, size, config });
  return config;
}

/** 读取并解析 gateway.json,应用各字段缺省值;校验失败抛出带路径的错误。 */
function parseGatewayConfig(path: string): GatewayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid gateway config (${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid gateway config (${path}): expected a JSON object.`);
  }
  const modelsBaseUrl = requireHttpUrl(raw, "modelsBaseUrl", path);
  return {
    modelsBaseUrl,
    protocolAliases: parseProtocolAliases(raw, path),
    modelsPath:
      typeof raw["modelsPath"] === "string" && raw["modelsPath"].startsWith("/")
        ? raw["modelsPath"]
        : DEFAULT_MODELS_PATH,
    providerName:
      typeof raw["providerName"] === "string" && raw["providerName"].length > 0
        ? raw["providerName"]
        : DEFAULT_GATEWAY_PROVIDER_NAME,
    defaultContextLength:
      typeof raw["defaultContextLength"] === "number" && Number.isInteger(raw["defaultContextLength"]) && raw["defaultContextLength"] > 0
        ? raw["defaultContextLength"]
        : DEFAULT_CONTEXT_LENGTH,
    headers: parseHeaders(raw, "headers", path),
    tokenHeaders: parseHeaders(raw, "tokenHeaders", path),
  };
}

/** 解析 protocolAliases(目录标签 → 协议映射);缺省返回空对象,值必须非空。 */
function parseProtocolAliases(raw: Record<string, unknown>, path: string): Readonly<Record<string, string>> {
  const value = raw["protocolAliases"];
  if (value === undefined) return EMPTY_PROTOCOL_ALIASES;
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway config (${path}): "protocolAliases" must be an object of label → protocol.`);
  }
  const aliases: Record<string, string> = {};
  for (const [label, protocol] of Object.entries(value)) {
    if (typeof protocol !== "string" || protocol.trim().length === 0) {
      throw new Error(`Invalid gateway config (${path}): "protocolAliases.${label}" must be a non-empty protocol name.`);
    }
    aliases[label] = protocol.trim();
  }
  return aliases;
}

/** 解析静态 / 令牌 header 对象;tokenHeaders 的值必须包含 {token} 占位符。 */
function parseHeaders(raw: Record<string, unknown>, field: string, path: string): Readonly<Record<string, string>> {
  const value = raw[field];
  if (value === undefined) return EMPTY_HEADERS;
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway config (${path}): "${field}" must be an object of header name → value.`);
  }
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
      throw new Error(`Invalid gateway config (${path}): "${field}.${name}" must be a non-empty string.`);
    }
    if (field === "tokenHeaders" && !headerValue.includes("{token}")) {
      throw new Error(
        `Invalid gateway config (${path}): "tokenHeaders.${name}" must contain the {token} placeholder (got "${headerValue}"). Use "headers" for static values.`,
      );
    }
    out[name] = headerValue.trim();
  }
  return out;
}

/** 校验字段为非空字符串,返回 trim 后的值。 */
function requireNonEmptyString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid gateway config (${path}): "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** 校验字段为 http(s) URL(本地开发网关允许 http);去掉结尾斜杠。 */
function requireHttpUrl(record: Record<string, unknown>, field: string, path: string): string {
  const value = requireNonEmptyString(record, field, path);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid gateway config (${path}): "${field}" must be a URL (got "${value}").`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Invalid gateway config (${path}): "${field}" must use http(s) (got "${value}"). Local http is allowed for development gateways.`,
    );
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** 类型收窄:判定通过后,TS 在该分支里把 unknown 当普通对象使用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
