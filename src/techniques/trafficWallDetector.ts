/**
 * Detects Shopee's anti-bot traffic-verification wall, which disguises itself as a plain
 * login page (`/verify/traffic/error?...&is_logged_in=false`). Used by session.manager.ts
 * right after navigation so we fail fast instead of waiting out the full timeout for a
 * get_pc/get_rw network call that will never come.
 */
export function isTrafficVerificationWall(url: string): boolean {
  return url.includes("/verify/traffic");
}
