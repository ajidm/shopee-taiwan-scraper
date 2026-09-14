export interface ShopeeSession {
  cookieHeader: string;
  headers: Record<string, string>;
  capturedAt: number;
  /** Raw get_pc/get_rw JSON body captured directly from the browser during bootstrap, if any. */
  capturedResponse: unknown | null;
}

export interface ShopeeProductParams {
  storeId: string;
  dealId: string;
}

export type ShopeeApiEndpoint = "get_pc" | "get_rw";
