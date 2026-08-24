/** Hosts that serve one deployment of the API. */
export interface Endpoints {
  /** Discovery, auth, accounts, collateral, trading, fills. */
  core: string;
  /** Ledger reads and realtime connection tokens. */
  ledger: string;
  /** Centrifugo WebSocket endpoint. */
  websocket: string;
}

export type EnvironmentName = "development" | "production";

/**
 * Known deployments.
 *
 * TODO: production hosts are not published yet. Selecting `production`
 * without supplying explicit endpoints throws rather than guessing a host.
 */
export const ENVIRONMENTS: Record<EnvironmentName, Endpoints | null> = {
  development: {
    core: "https://sol-trading-api.tiger.com",
    ledger: "https://sol-history-api.tiger.com",
    websocket: "wss://candles-data-ws.tiger.com/connection/websocket",
  },
  production: null,
};

export function resolveEndpoints(
  environment: EnvironmentName | undefined,
  overrides: Partial<Endpoints> | undefined,
): Endpoints {
  const base = environment ? ENVIRONMENTS[environment] : ENVIRONMENTS.development;

  if (!base) {
    const missing = (["core", "ledger", "websocket"] as const).filter((key) => !overrides?.[key]);
    if (missing.length) {
      throw new Error(
        `endpoints for "${environment}" are not published yet; pass { endpoints: { ${missing.join(", ")} } }`,
      );
    }
  }
  return { ...(base ?? {}), ...overrides } as Endpoints;
}

/** Path prefix shared by every route in this contract. */
export const API_PREFIX = "/v1/perp";
