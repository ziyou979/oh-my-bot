// Owner sign-in for the admin page, with no password to remember and no table to keep.
//
//   1. The owner sends /admin to the hub bot in a private chat. Telegram vouches for who sent it.
//   2. The hub answers with a login link that is good for 10 minutes.
//   3. Opening it swaps the link for a 12-hour session cookie (HttpOnly, Secure, SameSite=Strict).
//
// Both tokens are HMACs keyed by ADMIN_KEY, so rotating ADMIN_KEY signs every browser out.

const LOGIN_S = 10 * 60;
const SESSION_S = 12 * 60 * 60;
export const COOKIE = "omb_admin";

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`omb-admin|${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mint(secret: string, kind: "l" | "s", exp: number): Promise<string> {
  const head = `${kind}.${exp}.${nonce()}`;
  return `${head}.${await hmac(secret, head)}`;
}

async function verify(secret: string, kind: "l" | "s", token: string | null | undefined, nowS: number): Promise<boolean> {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== kind) return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < nowS) return false;
  const want = await hmac(secret, parts.slice(0, 3).join("."));
  const got = parts[3];
  if (want.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

export const mintLogin = (secret: string, nowMs: number) => mint(secret, "l", Math.floor(nowMs / 1000) + LOGIN_S);

/** A valid login link becomes a session token; anything else becomes null. */
export async function sessionFromLogin(secret: string, login: string | null, nowMs: number): Promise<string | null> {
  const nowS = Math.floor(nowMs / 1000);
  return (await verify(secret, "l", login, nowS)) ? mint(secret, "s", nowS + SESSION_S) : null;
}

export const checkSession = (secret: string, token: string | null | undefined, nowMs: number) =>
  verify(secret, "s", token, Math.floor(nowMs / 1000));

export function cookieValue(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export const sessionCookie = (token: string) => `${COOKIE}=${token}; Path=/admin; Max-Age=${SESSION_S}; HttpOnly; Secure; SameSite=Strict`;
export const clearCookie = () => `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
