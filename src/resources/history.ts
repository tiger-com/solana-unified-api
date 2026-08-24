import { API_PREFIX } from "../config.js";
import type { HttpClient } from "../http.js";
import type { FillsPage, LedgerPage, Venue } from "../types.js";

export interface PageOptions {
  /** 1–100; the API defaults to 50. */
  limit?: number;
  /** Opaque continuation cursor from the previous page. Never construct one. */
  cursor?: string;
  signal?: AbortSignal;
}

/**
 * Finalized history.
 *
 * Both surfaces page newest-first and stay readable after revocation.
 * `history_status` is `SYNCING` in the current phase: exhausting a page range
 * does not prove completeness, so reconciliation should re-read rather than
 * assume a traversal is final.
 */
export class HistoryResource {
  constructor(private readonly http: HttpClient) {}

  /** One page of finalized fills, from the core API. */
  fills(venue: Venue, nativeAccount: string, options: PageOptions = {}): Promise<FillsPage> {
    return this.http.request<FillsPage>({
      method: "GET",
      path:
        `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
        `/accounts/${encodeURIComponent(nativeAccount)}/fills`,
      query: { limit: options.limit, cursor: options.cursor },
      idempotent: true,
      signal: options.signal,
    });
  }

  /**
   * One page of the durable event ledger, from the ledger host.
   *
   * `events` is a discriminated union that will grow. Switch on `event_type`
   * and ignore types you do not handle; `supported_event_types` reports what
   * the deployment can currently return.
   */
  ledger(venue: Venue, nativeAccount: string, options: PageOptions = {}): Promise<LedgerPage> {
    return this.http.request<LedgerPage>({
      method: "GET",
      host: "ledger",
      path:
        `${API_PREFIX}/venues/${encodeURIComponent(venue)}` +
        `/accounts/${encodeURIComponent(nativeAccount)}/ledger`,
      query: { limit: options.limit, cursor: options.cursor },
      idempotent: true,
      signal: options.signal,
    });
  }

  /** Walks every fill page, newest first. */
  async *iterateFills(
    venue: Venue,
    nativeAccount: string,
    options: PageOptions = {},
  ): AsyncGenerator<FillsPage["fills"][number]> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.fills(venue, nativeAccount, { ...options, cursor });
      yield* page.fills;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Walks every ledger event page, newest first. */
  async *iterateLedger(
    venue: Venue,
    nativeAccount: string,
    options: PageOptions = {},
  ): AsyncGenerator<LedgerPage["events"][number]> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.ledger(venue, nativeAccount, { ...options, cursor });
      yield* page.events;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}
