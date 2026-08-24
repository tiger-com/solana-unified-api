import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    node: "src/node.ts",
    solana: "src/solana.ts",
    realtime: "src/realtime.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Never bundle the peer dependency: two copies of web3.js break instanceof
  // checks and prevent the consumer from sharing one Connection.
  external: ["@solana/web3.js"],
});
