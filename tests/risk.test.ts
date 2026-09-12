import { describe, expect, test } from "bun:test";
import { positionNotional, canOpen, dailyStopHit, roundSize, roundPrice, stopPrice } from "../src/risk";

const cfg = { riskPct: 0.5, slPct: 4, posCapPct: 12.5, maxPositions: 3, maxTradesPerDay: 10, dailyStopPct: -2, cooldownBars: 8 };

describe("risk", () => {
  test("30 USDT → 3.75 USDT pozisyon (risk 0.15)", () => {
    expect(positionNotional(30, cfg)).toBeCloseTo(3.75, 6);
  });
  test("tavan bağlayıcı: risk/stop tavanı aşarsa cap", () => {
    expect(positionNotional(100, { ...cfg, slPct: 1 })).toBe(12.5);
  });
  test("pozisyon tavanı", () => {
    expect(canOpen({ equity: 30, dayStartEquity: 30, openPositions: 3, tradesToday: 0, halted: false }, cfg).ok).toBe(false);
  });
  test("fren aktifken giriş yok", () => {
    expect(canOpen({ equity: 30, dayStartEquity: 30, openPositions: 0, tradesToday: 0, halted: true }, cfg).ok).toBe(false);
  });
  test("günlük fren -%2", () => {
    expect(dailyStopHit(29.4, 30, cfg)).toBe(true);
    expect(dailyStopHit(29.5, 30, cfg)).toBe(false);
  });
  test("stop fiyatı %4 altı", () => expect(stopPrice(100, cfg)).toBe(96));
  test("lot yuvarlama", () => {
    expect(roundSize(1234.7, 1, 1000)).toBe(1234);
    expect(roundSize(0.012345, 0.00001, 0.01)).toBeCloseTo(0.01234, 10);
    expect(roundSize(500, 1, 1000)).toBe(0);
  });
  test("fiyat tick yuvarlama", () => {
    expect(roundPrice(0.0035267, 0.000001)).toBeCloseTo(0.003526, 12);
    expect(roundPrice(77216.66, 0.1)).toBeCloseTo(77216.6, 6);
  });
});
