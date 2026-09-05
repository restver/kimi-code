/**
 * Okta SSO 模块在扩展宿主(extension host,VS Code 里运行扩展代码的那一侧)中的
 * 组装根 + 单例 —— 角色对齐 SDK 侧的组装方式(sdk-rpc-client-v2 里
 * `this.auth = new KimiAuthFacade({...})` 那一段):负责"什么时候创建这套对象、
 * 创建几个、什么时候销毁",并把用例门面挂成 `runtime.auth`(对应 `harness.auth`)。
 *
 * `initOktaModule` 在 `activate()` 里执行一次:注册 VS Code 身份认证提供器
 * (此时不需要 okta.json —— 配置是惰性解析的:扩展启动时不读,真正用到时才读),
 * 并触发 `restoreOnActivation`,把已存储的会话重新注入到新引擎进程的内存配置中。
 * 只有在流程真正用到时才会读取 okta.json:登录、令牌刷新、模型开通(provisioning)。
 * (登录入口的模式判定是纯配置读取,住在 okta-config.ts 的 readOktaMode,不经过这里。)
 *
 * `initOktaModule` 保证不抛异常:没有已存储会话时,模块保持静默,直到第一个 Okta
 * RPC(webview 经 bridge 发来的 Okta 相关请求)到来;okta.json 缺失或非法时,
 * 错误会呈现在 Okta 登录页上(通过 GetAuthMode / 登录流程),而不是写进日志。
 */
import * as vscode from "vscode";

import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";

import { Events } from "../../shared/bridge";

import { OktaAuthFacade } from "./auth-facade";

/** Okta 模块运行时:组装根产出的句柄 —— 消费面只有用例门面,对齐 `harness.auth`。 */
export interface OktaRuntime {
  /** 用例门面(登录 / 登出 / 状态);对应 `harness.auth`,provider/tokenStore 是它的私有实现。 */
  readonly auth: OktaAuthFacade;
  /** 运行时绑定的 SDK harness(组装键:harness 更换会触发整体重建)。 */
  readonly harness: KimiHarness;
  /** 模块销毁时需要一并释放的 VS Code 注册资源。 */
  readonly disposables: readonly vscode.Disposable[];
}

/** 模块级上下文:由 `initOktaModule` 在扩展激活时保存,供之后首次用到时构建运行时(惰性构建)。 */
interface OktaModuleContext {
  /** 扩展密钥存储,持久化令牌。 */
  readonly secrets: vscode.SecretStorage;
  readonly log: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
  /** 向所有 webview 广播事件;由 webview provider 初始化时传入。 */
  readonly broadcast: ((event: string, data: unknown) => void) | undefined;
}

let moduleContext: OktaModuleContext | undefined;
let runtime: OktaRuntime | undefined;

/** 获取当前 Okta 运行时;尚未初始化时返回 undefined。 */
export function getOktaRuntime(): OktaRuntime | undefined {
  return runtime;
}

/**
 * 初始化 Okta 模块:注册认证提供器并恢复上一次的会话。保证不抛异常
 * (内部错误只走 logError)。
 */
export function initOktaModule(options: {
  readonly context: vscode.ExtensionContext;
  readonly harness: KimiHarness;
  readonly log: (message: string) => void;
  readonly logError: (message: string, error: unknown) => void;
  /** 向所有 webview 广播事件;由 webview provider 初始化时传入。 */
  readonly broadcast?: (event: string, data: unknown) => void;
}): void {
  try {
    moduleContext = {
      secrets: options.context.secrets,
      log: options.log,
      logError: options.logError,
      broadcast: options.broadcast,
    };
    ensureOktaRuntime(options.harness);
  } catch (error) {
    options.logError("Okta SSO module failed to start", error);
  }
}

/** 幂等(重复调用无副作用):每个 harness 只构建一次运行时(扩展激活时或首个请求到来时)。 */
export function ensureOktaRuntime(harness: KimiHarness): OktaRuntime {
  if (runtime !== undefined && runtime.harness === harness) return runtime;
  // harness 已更换(例如引擎重启):先释放旧运行时再重建。
  if (runtime !== undefined) disposeRuntime();
  const host = moduleContext;
  if (host === undefined) {
    throw new Error("Okta module context is not initialized; extension activation did not run.");
  }
  // 门面在构造函数内部创建 provider / tokenStore(对齐 KimiAuthFacade 私有持有
  // toolkit 的方式),并接好引擎注入器与登出回调。
  const auth = new OktaAuthFacade({
    harness,
    secrets: host.secrets,
    log: host.log,
    logError: host.logError,
    // 由 webview 之外触发的登出(如 VS Code 账户头像菜单)同样需要
    // 通知 webview 重新初始化、回到登录界面。
    onSessionChanged: () => host.broadcast?.(Events.OktaSessionChanged, undefined),
  });
  // 注册进 VS Code 环境("怎么注册"是 provider 的私有知识),注册句柄由组装根保管与注销。
  const disposables = auth.provider.register();
  runtime = { auth, harness, disposables };
  // 异步恢复上一次的会话(不阻塞运行时的构建)。
  void auth.provider.restoreOnActivation();
  return runtime;
}

/** 释放当前运行时:先释放门面(停刷新定时器、销毁 provider 的事件),再注销 VS Code 资源。 */
function disposeRuntime(): void {
  const current = runtime;
  if (current === undefined) return;
  runtime = undefined;
  current.auth.dispose();
  for (const disposable of current.disposables) {
    disposable.dispose();
  }
}
