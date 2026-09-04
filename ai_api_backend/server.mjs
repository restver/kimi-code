#!/usr/bin/env node
/**
 * Test backend for the Okta SSO extension flow — ONE process, THREE roles:
 *
 *   1. Okta IdP (authorization server):
 *        GET  /v1/authorize            → 302 to redirect_uri?code&state (auto-consent)
 *        POST /v1/token                → authorization_code (PKCE S256) / refresh_token (rotating)
 *   2. Model catalog (your gateway):
 *        GET  /models                  → {data:[{model,name,provider,apiBase,contextLength}]}
 *   3. Inference (openai + openai_responses shapes, SSE):
 *        POST /v1/chat/completions
 *        POST /v1/responses
 *
 * Admin knobs for token-lifecycle testing:
 *        GET  /admin/state             → issued tokens / TTL / counters
 *        POST /admin/revoke            → kill ALL refresh tokens (next refresh → invalid_grant)
 *        POST /admin/expire            → force-expire ALL access tokens (next request → 401)
 *
 * Run:  node server.mjs            (then see README.md for okta.json / gateway.json samples)
 * Env:  PORT=9000  TOKEN_TTL=120   (access-token seconds; refresh rotates at TTL/2 by the client)
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 9000);
const TOKEN_TTL = Number(process.env.TOKEN_TTL ?? 60); // seconds
const CLIENT_ID = "0oa-test-mock-client";
const API_BASE = process.env.API_BASE ?? `http://127.0.0.1:${PORT}/v1`;
const HERE = dirname(fileURLToPath(import.meta.url));

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

// ── token stores ─────────────────────────────────────────────────────────
const authCodes = new Map(); // code → { challenge, redirectUri, clientId, expiresAt }
const refreshTokens = new Map(); // token → { rotatedTo, issuedAt }
const accessTokens = new Map(); // token → { expiresAt, revoked }
let counters = { logins: 0, refreshes: 0, rejectedRefreshes: 0, rejectedAccess: 0, modelLists: 0, inferences: 0 };

const b64url = (buf) => buf.toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function issueTokenPair(reason) {
  const accessToken = "at_" + b64url(randomBytes(24));
  const refreshToken = "rt_" + b64url(randomBytes(24));
  accessTokens.set(accessToken, { expiresAt: now() + TOKEN_TTL, revoked: false });
  refreshTokens.set(refreshToken, { rotatedTo: undefined, issuedAt: now() });
  log(`✅ token pair issued (${reason}) access=${accessToken.slice(0, 14)}… ttl=${TOKEN_TTL}s`);
  return { accessToken, refreshToken };
}

function accessValid(token) {
  const entry = accessTokens.get(token);
  if (entry === undefined || entry.revoked || entry.expiresAt <= now()) {
    if (entry !== undefined) log(`⛔ access token rejected: ${token.slice(0, 14)}… (${entry.revoked ? "revoked" : "expired"})`);
    return false;
  }
  return true;
}

// ── helpers ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function parseForm(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function sse(res, events) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function checkAuth(req) {
  const auth = req.headers["authorization"] ?? "";
  const apiKey = req.headers["api-key"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : apiKey;
  return token.length > 0 && accessValid(token);
}

// ── model catalog (override: put a models.json next to server.mjs) ──────
function modelCatalog() {
  try {
    return JSON.parse(readFileSync(join(HERE, "models.json"), "utf-8"));
  } catch {
    return {
      data: [
        { model: "gpt-test-mini", name: "GPT Test Mini", provider: "openai", apiBase: API_BASE, contextLength: "64000" },
        { model: "gpt-test-pro", name: "GPT Test Pro (high reasoning)", provider: "openai", apiBase: API_BASE, contextLength: "128000" },
        { model: "qwen-test", name: "Qwen Test", provider: "openrouter", apiBase: API_BASE, contextLength: "32000" },
      ],
    };
  }
}

// ── request handler ──────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // 1) IdP: authorize — auto-consent, 302 straight back with code+state
  if (req.method === "GET" && path === "/v1/authorize") {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    const state = q.get("state") ?? "";
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("client_id") !== CLIENT_ID || redirectUri === "" || challenge === "") {
      log("⛔ authorize: bad client_id / redirect_uri / code_challenge");
      return json(res, 400, { error: "invalid_request" });
    }
    const code = "ac_" + b64url(randomBytes(18));
    authCodes.set(code, { challenge, redirectUri, clientId: q.get("client_id"), expiresAt: now() + 60 });
    counters.logins += 1;
    log(`👤 authorize ok → 302 ${redirectUri.split("?")[0]} (state=${state.slice(0, 8)}…)`);
    res.writeHead(302, { Location: `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}code=${code}&state=${encodeURIComponent(state)}` });
    return res.end();
  }

  // 2) IdP: token — authorization_code (PKCE) | refresh_token (rotating)
  if (req.method === "POST" && path === "/v1/token") {
    const form = parseForm(await readBody(req));
    if (form["client_id"] !== CLIENT_ID) return json(res, 400, { error: "invalid_client" });

    if (form["grant_type"] === "authorization_code") {
      const entry = authCodes.get(form["code"] ?? "");
      authCodes.delete(form["code"] ?? ""); // single use
      if (entry === undefined || entry.expiresAt <= now()) {
        log("⛔ token: unknown/expired auth code");
        return json(res, 400, { error: "invalid_grant", error_description: "authorization code unknown or expired" });
      }
      if (entry.redirectUri !== form["redirect_uri"]) {
        return json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      }
      const verifier = form["code_verifier"] ?? "";
      const expected = b64url(createHash("sha256").update(verifier).digest());
      const a = Buffer.from(expected), b = Buffer.from(entry.challenge);
      if (verifier === "" || a.length !== b.length || !timingSafeEqual(a, b)) {
        log("⛔ token: PKCE verification failed");
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      const { accessToken, refreshToken } = issueTokenPair("login");
      return json(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL,
        scope: form["scope"] ?? "openid profile email offline_access",
      });
    }

    if (form["grant_type"] === "refresh_token") {
      const token = form["refresh_token"] ?? "";
      const entry = refreshTokens.get(token);
      if (entry === undefined) {
        counters.rejectedRefreshes += 1;
        log(`⛔ refresh rejected: ${token.slice(0, 14)}… (unknown or already rotated → client must re-login)`);
        return json(res, 400, { error: "invalid_grant", error_description: "refresh token invalid (rotated or revoked)" });
      }
      refreshTokens.delete(token); // rotation: old token dies on use
      const { accessToken, refreshToken } = issueTokenPair("refresh");
      refreshTokens.set(refreshToken, { rotatedTo: refreshToken, issuedAt: now() });
      counters.refreshes += 1;
      return json(res, 200, {
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL,
        scope: "openid profile email offline_access",
      });
    }

    return json(res, 400, { error: "unsupported_grant_type" });
  }

  // 3) catalog: /models
  if (req.method === "GET" && path === "/models") {
    if (!checkAuth(req)) {
      counters.rejectedAccess += 1;
      return json(res, 401, { error: "invalid_token", error_description: "access token missing, expired, or revoked" });
    }
    counters.modelLists += 1;
    log(`📋 models served (${counters.modelLists})`);
    return json(res, 200, modelCatalog());
  }

  // 4) inference: chat completions (openai)
  if (req.method === "POST" && path === "/v1/chat/completions") {
    if (!checkAuth(req)) {
      counters.rejectedAccess += 1;
      return json(res, 401, { error: "invalid_token", error_description: "access token missing, expired, or revoked" });
    }
    counters.inferences += 1;
    log(`💬 chat/completions #${counters.inferences}`);
    return sse(res, [
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hello from the mock backend. " }, finish_reason: null }] },
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Your token works." }, finish_reason: null }] },
      { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }

  // 5) inference: responses (openai_responses)
  if (req.method === "POST" && path === "/v1/responses") {
    if (!checkAuth(req)) {
      counters.rejectedAccess += 1;
      return json(res, 401, { error: "invalid_token", error_description: "access token missing, expired, or revoked" });
    }
    counters.inferences += 1;
    log(`💬 responses #${counters.inferences}`);
    return sse(res, [
      { type: "response.created", response: { id: "resp_test", object: "response", status: "in_progress" } },
      { type: "response.output_text.delta", delta: "Hello from the mock backend. " },
      { type: "response.output_text.delta", delta: "Your token works." },
      { type: "response.completed", response: { id: "resp_test", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } },
    ]);
  }

  // 6) admin: state / revoke / expire
  if (path === "/admin/state" && req.method === "GET") {
    return json(res, 200, {
      port: PORT,
      token_ttl_seconds: TOKEN_TTL,
      counters,
      access_tokens: [...accessTokens.entries()].map(([t, e]) => ({
        token: t.slice(0, 14) + "…",
        expires_in: e.expiresAt - now(),
        revoked: e.revoked,
      })),
      refresh_tokens_alive: refreshTokens.size,
      pending_auth_codes: authCodes.size,
    });
  }
  if (path === "/admin/revoke" && req.method === "POST") {
    refreshTokens.clear();
    log("🔧 ADMIN: all refresh tokens revoked — next client refresh gets invalid_grant");
    return json(res, 200, { ok: true, revoked: "refresh_tokens" });
  }
  if (path === "/admin/expire" && req.method === "POST") {
    for (const entry of accessTokens.values()) entry.revoked = true;
    log("🔧 ADMIN: all access tokens force-expired — next request gets 401");
    return json(res, 200, { ok: true, revoked: "access_tokens" });
  }

  json(res, 404, { error: "not_found", path });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`🚀 mock backend on http://127.0.0.1:${PORT}`);
  log(`   IdP      issuer = http://127.0.0.1:${PORT}   (/v1/authorize, /v1/token)`);
  log(`   catalog  GET /models   (Bearer)`);
  log(`   infer    POST /v1/responses | /v1/chat/completions (Bearer)`);
  log(`   admin    GET /admin/state | POST /admin/revoke | POST /admin/expire`);
  log(`   TOKEN_TTL=${TOKEN_TTL}s  CLIENT_ID=${CLIENT_ID}`);
});
