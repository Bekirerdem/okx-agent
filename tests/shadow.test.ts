import { describe, expect, test } from "bun:test";
import { detectBreakout, stepShadow, emptyShadow, type ShadowState } from "../src/shadow";
import type { Bar } from "../src/signals";

const mk = (o: number, h: number, l: number, c: number, v = 1, i = 0): Bar => ({ ts: i, o, h, l, c, v });
const base = Array.from({ length: 24 }, (_, i) => mk(100, 101, 99, 100, 1, i));

describe("gölge bot", () => {
  test("hacimli kırılım → sinyal", () => {
    expect(detectBreakout([...base, mk(100, 102, 100, 101.5, 3, 24)])).toBe(true);
  });
  test("hacimsiz kırılım → sinyal yok", () => {
    expect(detectBreakout([...base, mk(100, 102, 100, 101.5, 1, 24)])).toBe(false);
  });
  test("aç → SL'de kapan, komisyon dahil −1.2%", () => {
    let s: ShadowState = emptyShadow();
    s = stepShadow(s, "X-USDT", [...base, mk(100, 102, 100, 101.5, 3, 24)], 30, 0);
    expect(s.trades).toBe(1); expect(s.open["X-USDT"]?.entry).toBe(101.5);
    s = stepShadow(s, "X-USDT", [...base, mk(101.5, 101.6, 100.3, 100.5, 1, 25)], 30, 60_000);
    expect(s.open["X-USDT"]).toBeUndefined();
    expect(s.closed[0]!.why).toBe("SL");
    expect(s.closed[0]!.pnlPct).toBeCloseTo(-1.2, 6);
  });
  test("2 saat sonra zaman stopu", () => {
    let s: ShadowState = emptyShadow();
    s = stepShadow(s, "X-USDT", [...base, mk(100, 102, 100, 101.5, 3, 24)], 30, 0);
    s = stepShadow(s, "X-USDT", [...base, mk(101.5, 101.9, 101.2, 101.7, 1, 25)], 30, 2 * 3600_000 + 1);
    expect(s.closed[0]!.why).toBe("zaman");
  });
});
