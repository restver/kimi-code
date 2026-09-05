/**
 * Okta 授权码流程的本地回环服务器(临时开在本机 127.0.0.1 上、专门接收登录
 * 回调的小 HTTP 服务)。IdP(身份提供方,这里就是 Okta)完成用户认证后,浏览器
 * 会落在 `http://127.0.0.1:<port><redirectPath>?code=...&state=...`;服务器核对
 * state(登录开始时生成的随机串,带回来的必须一致,防止伪造回调),回应一个极简
 * 的"可以关闭本页"文档,并且只让回调 Promise 出一次结果(settle:resolve 或
 * reject 只发生一次)。端口按顺序尝试,单个端口被占用不会让整个登录失败;
 * 流程结束(超时、取消、授权码已换完)后由调用方负责销毁服务器。
 */
import * as http from "node:http";

/** 回调结果:授权码,或错误描述。 */
export type LoopbackCallbackResult =
  | { readonly code: string }
  | { readonly error: string };

/** 启动后的回环服务器句柄。 */
export interface LoopbackServer {
  /** 实际监听成功的端口。 */
  readonly port: number;
  /** 传给 Okta authorize 请求的 redirect_uri。 */
  readonly redirectUri: string;
  /** 收到合法回调(或错误)时产出结果的 Promise。 */
  readonly callback: Promise<LoopbackCallbackResult>;
  /** 关闭服务器;若登录流程仍在等待,则以"登录窗口已关闭"的错误结束它的等待。 */
  dispose(): void;
}

/** 登录完成后返回给浏览器的极简 HTML 页面。 */
const CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sign-in complete</title></head>
<body style="font-family: sans-serif; text-align: center; padding-top: 3rem">
<h2>Sign-in complete</h2><p>You can close this page and return to VS Code.</p>
</body></html>`;

/** 按顺序尝试端口启动回环服务器;全部被占用则抛错。 */
export async function startLoopbackServer(options: {
  readonly ports: readonly number[];
  readonly redirectPath: string;
  readonly state: string;
}): Promise<LoopbackServer> {
  if (options.ports.length === 0) {
    throw new Error("Okta loopback server has no ports configured.");
  }
  const triedPorts: number[] = [];
  for (const port of options.ports) {
    triedPorts.push(port);
    try {
      return await listenOnce(port, options);
    } catch (error) {
      if (!isAddrInUse(error)) throw error;
    }
  }
  throw new Error(
    `Okta callback ports are all in use: ${triedPorts.join(", ")}. Free one of them or adjust "callbackPorts" in okta.json.`,
  );
}

/** 在单个端口上监听一次回调。 */
function listenOnce(port: number, options: {
  readonly redirectPath: string;
  readonly state: string;
}): Promise<LoopbackServer> {
  return new Promise<LoopbackServer>((resolve, reject) => {
    // settled / disposed 双旗标:回调 Promise 只 settle 一次,服务器只关闭一次。
    let settled = false;
    let disposed = false;
    let settle: (result: LoopbackCallbackResult) => void = () => {};
    const callback = new Promise<LoopbackCallbackResult>((resolveCallback) => {
      settle = resolveCallback;
    });

    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== options.redirectPath) {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      if (error !== null) {
        respondAndSettle(response, `Okta authorization failed: ${error}`, () => {
          settleIf(() => {
            settle({ error: `Okta authorization failed: ${error}` });
          });
        });
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (code === null || state !== options.state) {
        // 外来或被篡改的回调:给出响应,但绝不让流程拿到结果(流程继续等真正的回调)。
        response.writeHead(400).end("Invalid callback");
        return;
      }
      respondAndSettle(response, undefined, () => {
        settleIf(() => {
          settle({ code });
        });
      });
    });

    // 释放:流程仍在等待时以"登录窗口已关闭"的错误结束等待,再关闭服务器。
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      settleIf(() => {
        settle({ error: "Sign-in window closed." });
      });
      server.close();
    };

    // 保证回调 Promise 只出一次结果(resolve 或 reject)。
    const settleIf = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    // 监听失败(如端口被占用):reject 交给上层,startLoopbackServer 会尝试下一个端口。
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (disposed) return;
      server.close();
      reject(error);
    });
    // 只绑定回环地址,不把回调服务器暴露到外网。
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${options.redirectPath}`,
        callback,
        dispose,
      });
    });
  });
}

/** 先回应浏览器,再让回调出结果。 */
function respondAndSettle(
  response: http.ServerResponse,
  error: string | undefined,
  settle: () => void,
): void {
  response.writeHead(error === undefined ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" });
  response.end(error === undefined ? CALLBACK_HTML : error);
  settle();
}

/** 判断错误是否为端口被占用(EADDRINUSE)。 */
function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}
