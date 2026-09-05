import { Events, Methods } from "../../shared/bridge";
import type { LoginResult } from "../../shared/legacy-sdk";
import { readOktaMode } from "../okta/okta-config";
import { ensureOktaRuntime } from "../okta/runtime";
import type { Handler } from "./types";

export interface OktaStatusResult {
  readonly configured: boolean;
  readonly loggedIn: boolean;
  readonly providerNames: readonly string[];
}

export interface AuthModeResult {
  readonly mode: "okta" | "kimi";
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const oktaHandlers: Record<string, Handler<any, any>> = {
  [Methods.OktaLogin]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ensureOktaRuntime(ctx.harness).auth.login({
        onLoginUrl: (url) => ctx.broadcast(Events.OktaLoginUrl, { url }, ctx.webviewId),
      });
      return { success: true };
    } catch (error) {
      ctx.logError("Okta login failed", error);
      return { success: false, error: errorMessage(error) };
    }
  },

  [Methods.OktaStatus]: async (_, ctx): Promise<OktaStatusResult> => {
    const mode = readOktaMode(ctx.harness.homeDir);
    if (mode.error !== null) {
      ctx.logError("Okta SSO is misconfigured", mode.error);
      return { configured: false, loggedIn: false, providerNames: [] };
    }
    if (mode.mode === "kimi") {
      return { configured: false, loggedIn: false, providerNames: [] };
    }
    try {
      const status = await ensureOktaRuntime(ctx.harness).auth.status();
      return { configured: true, loggedIn: status.loggedIn, providerNames: status.providerNames };
    } catch {
      return { configured: false, loggedIn: false, providerNames: [] };
    }
  },

  [Methods.OktaLogout]: async (_, ctx): Promise<LoginResult> => {
    try {
      await ensureOktaRuntime(ctx.harness).auth.logout();
      return { success: true };
    } catch (error) {
      ctx.logError("Okta logout failed", error);
      return { success: false, error: errorMessage(error) };
    }
  },

  [Methods.GetAuthMode]: async (_, ctx): Promise<AuthModeResult> => {
    return readOktaMode(ctx.harness.homeDir);
  },
};
