import { test } from "node:test";
import assert from "node:assert/strict";
import { recentDevWalletsFrom, type MemLike } from "./wallet-mem-select.ts";

test("picks wallets seen in the dev role, most recently updated first", () => {
  // Object key order is insertion order: "alice" was touched again after "bob" and "carol" (dev),
  // so a naive Object.keys() scan would miss that alice is now the most recent entry.
  const mem: MemLike = {
    bob: [{ t: "tokenB", c: "solana", r: "sniper" }],
    carol: [{ t: "tokenC", c: "solana", r: "dev" }],
    alice: [{ t: "tokenA", c: "solana", r: "dev" }],
  };
  assert.deepEqual(recentDevWalletsFrom(mem, 10), ["alice", "carol"]);
});

test("accepts legacy string entries (old Solana-only memory format) without crashing", () => {
  const mem: MemLike = { oldWallet: ["someTokenMint"] };
  assert.deepEqual(recentDevWalletsFrom(mem, 10), []);
});

test("respects the limit", () => {
  const mem: MemLike = {
    w1: [{ t: "t1", c: "solana", r: "dev" }],
    w2: [{ t: "t2", c: "solana", r: "dev" }],
    w3: [{ t: "t3", c: "solana", r: "dev" }],
  };
  assert.deepEqual(recentDevWalletsFrom(mem, 2), ["w3", "w2"]);
});

test("a wallet with multiple tokens counts once if any role is dev", () => {
  const mem: MemLike = {
    w: [
      { t: "t1", c: "solana", r: "sniper" },
      { t: "t2", c: "bsc", r: "dev" },
    ],
  };
  assert.deepEqual(recentDevWalletsFrom(mem, 10), ["w"]);
});

test("limit of 0 returns nothing", () => {
  const mem: MemLike = { w: [{ t: "t1", c: "solana", r: "dev" }] };
  assert.deepEqual(recentDevWalletsFrom(mem, 0), []);
});
