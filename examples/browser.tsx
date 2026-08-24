/**
 * Browser usage with a wallet-adapter wallet.
 *
 * Note: the API sends `Access-Control-Allow-Origin` only for allow-listed
 * origins. A browser client on any other origin cannot reach it until Tiger
 * adds that origin.
 */
import { useWallet } from "@solana/wallet-adapter-react";
import { useMemo, useState } from "react";

import { PerpClient, type Account } from "@tigercom/perp-sdk";
import { walletAdapterSigner } from "@tigercom/perp-sdk/browser";

export function useTigerPerp() {
  const wallet = useWallet();
  const [prompting, setPrompting] = useState(false);

  return useMemo(() => {
    if (!wallet.publicKey || !wallet.signMessage) return null;

    return new PerpClient({
      environment: "development",
      signer: walletAdapterSigner(wallet),
      // The token lives 24 hours and there is no refresh token, so renewal is
      // another wallet popup. Surfacing it keeps the prompt from feeling random.
      onAuthRequired: async ({ reason }) => {
        setPrompting(true);
        try {
          return window.confirm(
            reason === "expired"
              ? "Your trading session expired. Sign in again?"
              : "Sign a message to start a trading session?",
          );
        } finally {
          setPrompting(false);
        }
      },
    });
  }, [wallet.publicKey?.toBase58(), prompting]);
}

export function Accounts() {
  const client = useTigerPerp();
  const [accounts, setAccounts] = useState<Account[]>([]);

  async function load() {
    if (!client) return;
    setAccounts(await client.accounts.list({ venue: "PHX" }));
  }

  return (
    <div>
      <button onClick={load} disabled={!client}>
        Load accounts
      </button>
      <ul>
        {accounts.map((account) => (
          <li key={account.native_account}>
            {account.name} — {account.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
