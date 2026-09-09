/**
 * 网关模型开通(provisioning):从用户自己的 API 拉取模型目录并写入
 * config.toml。目录里的每个条目都自带推理端点(apiBase)和协议
 * ("provider": openai | openai_responses | anthropic | …),因此模型按
 * (protocol, apiBase) 分组 —— 每组生成一个 config.toml provider 段(config.toml
 * 里 [providers.名字] 这样的一节;type = protocol,baseUrl = apiBase,
 * `apiKey: ""`)。任何凭据都不写进磁盘文件:
 * Okta 访问令牌通过引擎的内存配置层(`KimiHarness.setMemoryConfig`,
 * 见 token-store.ts)按请求注入到每个生成的 provider。
 *
 * 归属规则沿用 `applyManagedKimiCodeConfig`(packages/oauth):名字带我们
 * 前缀的 provider 段和模型别名会被当前目录整体替换(过期分组移除,用户的
 * `overrides` 子对象保留);`[models]` / `[providers]` 里其余内容一律不动。
 * 写入走 harness 的原子段替换(整段要么全部写成功、要么完全不写,不会写一半)。
 */
import type { KimiConfig, KimiHarness, ProviderType } from "@moonshot-ai/kimi-code-sdk";

import type { GatewayConfig } from "./gateway-config";

/** 可作为 config.toml provider `type` 的值(ProviderTypeSchema)。 */
const KNOWN_PROTOCOLS = new Set(["anthropic", "openai", "openai_responses", "kimi", "google-genai", "vertexai"]);

/** 模型条目(models.<id>.protocol)上合法的线上协议。 */
const MODEL_PROTOCOLS = new Set(["anthropic", "openai", "openai_responses", "google-genai"]);

/** `{data: [...]}` 里的一条目录条目 —— 网关的原始数据形状。 */
export interface OktaModelEntry {
  /** 推理请求 payload 里的模型 id。 */
  readonly model: string;
  /** 面向人的名字(下拉框标签);缺省用 id。 */
  readonly displayName: string;
  /** 推理协议;成为 provider 段的 `type`。 */
  readonly protocol: string;
  /** 该模型自己的推理端点(所属 provider 分组的 baseUrl)。 */
  readonly apiBase: string;
  /** 目录声明了窗口大小时的 token 数。 */
  readonly contextLength: number | undefined;
}

/** 开通结果:模型数量、默认模型、生成的 provider 行 —— 即引擎注入的载荷。 */
export interface OktaProvisionResult {
  readonly modelsCount: number;
  readonly defaultModel: string;
  /** 生成的 provider 行(不含 apiKey)。 */
  readonly providerRows: Readonly<Record<string, { type: string; baseUrl: string; customHeaders?: Record<string, string> }>>;
}

/** 拉取模型目录:GET {modelsBaseUrl}{modelsPath},同时携带两种认证头以兼容不同网关。 */
export async function fetchOktaModels(gateway: GatewayConfig, accessToken: string): Promise<OktaModelEntry[]> {
  const url = `${gateway.modelsBaseUrl}${gateway.modelsPath}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "api-key": accessToken,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Model list request to ${url} failed: ${describeFetchFailure(error)}`, { cause: error });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    const message = isRecord(detail) && typeof detail["error"] === "string"
      ? detail["error"]
      : isRecord(detail) && typeof detail["message"] === "string"
        ? detail["message"]
        : "unknown error";
    throw new Error(`Model list request to ${url} failed (HTTP ${response.status}): ${message}`);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  // 兼容两种目录形状:顶层数组,或 {data: [...]} 包裹。
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload["data"])
      ? payload["data"]
      : [];
  const models: OktaModelEntry[] = [];
  // 按 (protocol, apiBase, model) 去重。
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = parseModelEntry(raw, url, gateway.protocolAliases);
    if (entry === undefined) continue;
    const key = `${entry.protocol}\n${entry.apiBase}\n${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(entry);
  }
  if (models.length === 0) {
    throw new Error(`No models available from ${url}.`);
  }
  return models;
}

/** 解析并校验单条目录条目;非对象或缺 id 时跳过,字段缺失 / 协议不支持时抛错。 */
function parseModelEntry(
  raw: unknown,
  url: string,
  protocolAliases: Readonly<Record<string, string>>,
): OktaModelEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const model = nonEmptyString(raw["model"]) ?? nonEmptyString(raw["id"]);
  if (model === undefined) return undefined;
  const protocolLabel = nonEmptyString(raw["provider"]);
  if (protocolLabel === undefined) {
    throw new Error(`A model entry from ${url} ("${model}") is missing "provider" (the inference protocol).`);
  }
  // 标签 → 协议的映射是部署侧知识,绝不在这里猜:所有映射都来自 gateway.json
  // 的 protocolAliases。未知标签大声报错,让管理员显式补上映射。
  const protocol = protocolAliases[protocolLabel] ?? protocolLabel;
  if (!KNOWN_PROTOCOLS.has(protocol)) {
    if (protocolAliases[protocolLabel] !== undefined) {
      throw new Error(
        `protocolAliases maps "${protocolLabel}" to "${protocol}", which is not a supported protocol. Supported: ${[...KNOWN_PROTOCOLS].join(", ")}.`,
      );
    }
    throw new Error(
      `Model "${model}" from ${url} declares an unsupported protocol "${protocol}". Supported: ${[...KNOWN_PROTOCOLS].join(", ")}.`,
    );
  }
  const apiBaseRaw = nonEmptyString(raw["apiBase"]);
  if (apiBaseRaw === undefined) {
    throw new Error(`A model entry from ${url} ("${model}") is missing "apiBase" (its inference endpoint).`);
  }
  let apiBase: URL;
  try {
    apiBase = new URL(apiBaseRaw);
  } catch {
    throw new Error(`Model "${model}" from ${url} has an invalid "apiBase" (got "${apiBaseRaw}").`);
  }
  if (apiBase.protocol !== "https:" && apiBase.protocol !== "http:") {
    throw new Error(`Model "${model}" from ${url} has a non-http(s) "apiBase" (got "${apiBaseRaw}").`);
  }
  return {
    model,
    displayName: nonEmptyString(raw["name"]) ?? model,
    protocol,
    apiBase: trimTrailingSlash(apiBaseRaw),
    contextLength: parseContextLength(raw["contextLength"]),
  };
}

/** 解析 contextLength;非正整数或非法输入返回 undefined。 */
function parseContextLength(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * 纯段落构建器:把目录按 (protocol, apiBase) 分组,生成 `<prefix>-<protocol>`
 * 命名的 provider 段(短名、不含 host;同协议的第二组依次 -2、-3 …);为每个
 * 模型写一条带显式 `protocol` 的别名(聊天预检要求 models.<id>.protocol,
 * 因此从不依赖 provider.type 兜底);返回完整的、保留外来条目的
 * `providers` / `models` / `defaultModel` 段,可直接交给
 * `replaceConfigSections`。带我们前缀但已不在当前目录里的段和别名会被移除
 * (重新登录时过期分组就被清理掉了 —— 也包括旧的长 host 后缀命名)。
 */
export function applyOktaProviderConfig(
  config: KimiConfig,
  input: {
    readonly gateway: GatewayConfig;
    readonly models: readonly OktaModelEntry[];
  },
): {
  providers: NonNullable<KimiConfig["providers"]>;
  models: NonNullable<KimiConfig["models"]>;
  defaultModel: string;
  providerRows: Readonly<Record<string, { type: string; baseUrl: string; customHeaders?: Record<string, string> }>>;
} {
  const { gateway } = input;
  if (input.models.length === 0) {
    throw new Error("No models available for the Okta provider.");
  }
  const prefix = `${gateway.providerName}-`;

  // 确定性分组:同一目录 → 同一组生成名,重新开通时不会产生任何配置变更,过期分组也在重新登录时被清理。
  const groups = new Map<string, { protocol: string; apiBase: string }>();
  for (const entry of input.models) {
    groups.set(`${entry.protocol}\n${entry.apiBase}`, { protocol: entry.protocol, apiBase: entry.apiBase });
  }
  // 名字只在本次开通轮次内占用:带我们前缀的现有段是可替换的(同组可复用其名),
  // 外来段不会冲突,因为生成的名字永远以我们的前缀开头。同 protocol+host 的
  // 不同分组依次 -2、-3 …。
  const taken = new Set<string>();
  const providers: NonNullable<KimiConfig["providers"]> = { ...config.providers };
  const nameByGroup = new Map<string, string>();
  const rows: Record<string, { type: string; baseUrl: string; customHeaders?: Record<string, string> }> = {};
  const staticHeaders = Object.keys(gateway.headers).length > 0 ? { customHeaders: { ...gateway.headers } } : {};
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const base = `${gateway.providerName}-${group.protocol}`;
    let name = base;
    let suffix = 2;
    while (taken.has(name)) {
      name = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(name);
    nameByGroup.set(key, name);
    providers[name] = {
      // 解析时已由 KNOWN_PROTOCOLS 校验收窄。
      type: group.protocol as ProviderType,
      baseUrl: group.apiBase,
      apiKey: "",
      ...staticHeaders,
    };
    rows[name] = { type: group.protocol, baseUrl: group.apiBase, ...staticHeaders };
  }

  const existingModels: NonNullable<KimiConfig["models"]> = { ...config.models };
  const aliasFor = (providerEntry: string, model: string): string => `${providerEntry}/${model}`;
  const aliasKeys = new Set<string>();
  for (const entry of input.models) {
    const providerEntry = nameByGroup.get(`${entry.protocol}\n${entry.apiBase}`);
    if (providerEntry !== undefined) aliasKeys.add(aliasFor(providerEntry, entry.model));
  }

  // 移除带我们前缀但目录已不再列出的过期别名和 provider 段;别人的东西一律保留。
  for (const [key, alias] of Object.entries(existingModels)) {
    if (
      isRecord(alias) &&
      typeof alias["provider"] === "string" &&
      alias["provider"].startsWith(prefix) &&
      !aliasKeys.has(key)
    ) {
      delete existingModels[key];
    }
  }
  for (const name of Object.keys(providers)) {
    if (name.startsWith(prefix) && !taken.has(name)) {
      delete providers[name];
    }
  }
  // 写入我们的别名;用户附加的内容(如 `overrides`)在合并后仍然存活。
  for (const entry of input.models) {
    const providerEntry = nameByGroup.get(`${entry.protocol}\n${entry.apiBase}`);
    if (providerEntry === undefined) continue;
    const key = aliasFor(providerEntry, entry.model);
    const previous = isRecord(existingModels[key]) ? existingModels[key] : {};
    existingModels[key] = {
      ...previous,
      provider: providerEntry,
      model: entry.model,
      maxContextSize: entry.contextLength ?? gateway.defaultContextLength,
      displayName: entry.displayName,
      // 模型级字段是引擎解析链里的第一优先级来源;provider 段只是兜底,缺失时会
      // 悄悄改用 provider 定义的 defaultBaseUrl(api.openai.com/v1)。两处都显式
      // 写入,坏的 provider 行才永远不会把请求重定向到厂商默认端点。
      baseUrl: entry.apiBase,
      ...(MODEL_PROTOCOLS.has(entry.protocol) ? { protocol: entry.protocol as "anthropic" } : {}),
    };
  }

  // 默认模型:用户自己的默认值优先;若当前默认就是我们生成的别名,则跟随目录更新。
  const currentDefault = typeof config.defaultModel === "string" ? config.defaultModel : undefined;
  const currentAlias = currentDefault !== undefined ? existingModels[currentDefault] : undefined;
  const currentIsOurs = isRecord(currentAlias) && typeof currentAlias["provider"] === "string" && currentAlias["provider"].startsWith(prefix);
  const firstAlias = aliasKeys.values().next().value as string;
  const defaultModel = currentDefault !== undefined && !currentIsOurs ? currentDefault : firstAlias;

  return { providers, models: existingModels, defaultModel, providerRows: rows };
}

/** 开通主流程:拉目录 → 算段落 → 原子替换写入,返回开通结果。 */
export async function provisionOktaModels(input: {
  readonly harness: KimiHarness;
  readonly gateway: GatewayConfig;
  readonly accessToken: string;
}): Promise<OktaProvisionResult> {
  const { harness, gateway, accessToken } = input;
  // 开通依赖默认(v2)引擎的原子段替换能力。
  if (!harness.supportsAtomicSectionReplace()) {
    throw new Error(
      "Okta SSO requires the default (v2) engine. Disable the 'kimi.useAgentCoreV1' setting, reload the window, and sign in again.",
    );
  }
  const models = await fetchOktaModels(gateway, accessToken);
  const current = await harness.getConfig({ reload: true });
  const sections = applyOktaProviderConfig(current, {
    gateway,
    models,
  });
  await harness.replaceConfigSections({
    providers: sections.providers,
    models: sections.models,
    defaultModel: sections.defaultModel,
  });
  return { modelsCount: models.length, defaultModel: sections.defaultModel, providerRows: sections.providerRows };
}

/** 移除所有生成的 provider 段(登出时)。 */
export async function removeOktaProviders(harness: KimiHarness, providerNames: readonly string[]): Promise<void> {
  for (const name of providerNames) {
    await harness.removeProvider(name);
  }
  await harness.getConfig({ reload: true });
}

/** 非空字符串则返回 trim 后的值,否则 undefined。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 去掉结尾斜杠。 */
function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** 把错误(含 cause 链)拼成可读描述,去重后用 ": " 连接。 */
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
