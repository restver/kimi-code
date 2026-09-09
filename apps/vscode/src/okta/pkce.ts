/**
 * PKCE(RFC 7636,Proof Key for Code Exchange)与 OAuth state 工具:为 Okta
 * 授权码流程生成 code_verifier / code_challenge 以及随机 state。PKCE 的作用:
 * 每次登录先生成一对随机密钥,challenge 随授权请求发给 Okta,verifier 只在换
 * 令牌时出示,防止授权码被中间人截走后冒用。
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

/** PKCE verifier 的合法字符集(RFC 7636 的 unreserved 字符)。 */
const PKCE_VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export interface PkceChallenge {
  /** 原始 verifier,换令牌时作为 code_verifier 回传给授权服务器。 */
  readonly verifier: string;
  /** 发给授权服务器的 S256 challenge。 */
  readonly challenge: string;
}

/** 生成指定长度的随机 verifier(仅使用 URL 安全字符)。 */
export function createPkceVerifier(length = 64): string {
  let verifier = "";
  for (let i = 0; i < length; i += 1) {
    verifier += PKCE_VERIFIER_ALPHABET[randomInt(PKCE_VERIFIER_ALPHABET.length)];
  }
  return verifier;
}

/** RFC 7636 的 S256 challenge:base64url(SHA-256(verifier)),去掉填充。 */
export function createPkceChallenge(): PkceChallenge {
  const verifier = createPkceVerifier();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 生成随机 OAuth state,用于回调时防 CSRF 校验。 */
export function randomState(): string {
  return randomBytes(24).toString("hex");
}
