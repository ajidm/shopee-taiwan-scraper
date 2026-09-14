export type SessionStatus = "healthy" | "degraded" | "blocked" | "expired";

export interface ShopeeSession {
  cookieHeader: string;
  headers: Record<string, string>;
  capturedAt: number;
  /** Raw get_pc/get_rw JSON body captured directly from the browser during bootstrap, if any. */
  capturedResponse: unknown | null;
  /** The exact proxy URL this session's browser bootstrap went out through, if any — reused
   * for all of this session's axios calls so the exit IP never changes mid-session even if
   * the sticky proxy list has multiple entries. */
  proxyUrl: string | null;
  status: SessionStatus;
  successCount: number;
  errorCount: number;
  refreshCount: number;
}

export interface ShopeeProductParams {
  storeId: string;
  dealId: string;
}

export type ShopeeApiEndpoint = "get_pc" | "get_rw";
