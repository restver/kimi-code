#!/usr/bin/env node
/**
 * End-to-end smoke test against server.mjs — no VS Code needed.
 * PKCE login → /models → inference (api-key header) → refresh rotation →
 * old-refresh reuse rejected → forced expiry → 401.
 *
 * Run: node server.mjs & ; node test-flow.mjs [--bad-pkce]
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BASE = process.env.BASE ?? "http://127.0.0.1:9000";
const CLIENT_ID = "0oa-test-mock-client";
const b64url = (buf) => buf.toString("base64url");
const badPkce = process.argv.includes("--bad-pkce");

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1) loopback receiver: one server, returns {code, redirectUri} once hit
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
let callbackPort = 0;
const callback = await new Promise((resolve) => {
  const receiver = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>callback received</h1>");
    receiver.close();
    resolve({ code: new URL(req.url ?? "/", "http://x").searchParams.get("code"), redirectUri: `http://127.0.0.1:${callbackPort}/callback` });
  });
  receiver.listen(0, "127.0.0.1", () => {
    callbackPort = receiver.address().port;
    const url = new URL(`${BASE}/v1/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", `http://127.0.0.1:${callbackPort}/callback`);
    url.searchParams.set("state", "smoke");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    void fetch(url, { redirect: "manual" }).then((response) => {
      const location = response.headers.get("location") ?? "";
      if (!location.startsWith(`http://127.0.0.1:${callbackPort}`)) {
        receiver.close();
        resolve({ code: null, redirectUri: null, error: `authorize status=${response.status}` });
        return;
      }
      void fetch(location).catch(() => {}); // triggers the receiver
    });
  });
});

// 2) token exchange
step("authorize → code+state callback", callback.code !== null, callback.error ?? "");
const tokenResponse = await fetch(`${BASE}/v1/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: callback.code ?? "",
    redirect_uri: callback.redirectUri ?? "",
    client_id: CLIENT_ID,
    code_verifier: badPkce ? b64url(randomBytes(48)) : verifier,
  }),
});
const tokens = await tokenResponse.json();
if (badPkce) {
  step("bad PKCE rejected", tokenResponse.status === 400 && tokens["error"] === "invalid_grant");
} else {
  step("token exchange", tokenResponse.status === 200 && typeof tokens["access_token"] === "string", `expires_in=${tokens["expires_in"]}s`);

  // 3) models
  const modelsResponse = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${tokens["access_token"]}` } });
  const models = await modelsResponse.json();
  step("models list", modelsResponse.status === 200 && (models["data"]?.length ?? 0) > 0, `${models["data"]?.length} models`);

  // 4) inference via api-key header (proves the tokenHeaders path)
  const infer = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { "api-key": tokens["access_token"], "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-test-pro", input: "hi", stream: true }),
  });
  step("inference SSE (api-key header)", infer.status === 200 && (infer.headers.get("content-type") ?? "").includes("event-stream"));

  // 5) refresh rotation
  const refreshResponse = await fetch(`${BASE}/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens["refresh_token"], client_id: CLIENT_ID }),
  });
  const refreshed = await refreshResponse.json();
  step("refresh rotation", refreshResponse.status === 200 && refreshed["refresh_token"] !== tokens["refresh_token"]);

  // 6) reusing the OLD refresh token must fail
  const reuse = await fetch(`${BASE}/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens["refresh_token"], client_id: CLIENT_ID }),
  });
  step("old refresh rejected", reuse.status === 400);

  // 7) force-expire → 401
  await fetch(`${BASE}/admin/expire`, { method: "POST" });
  const expired = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${refreshed["access_token"]}` } });
  step("expired access → 401", expired.status === 401);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "🎉 all" : "💥"} ${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length === 0 ? 0 : 1);
