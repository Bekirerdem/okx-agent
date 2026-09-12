import { describe, expect, test } from "bun:test";
import { detectSweep, btcGate, relStrength, targetPrice, bookImbalance, rsi, ema, atrPct, volRatio, technicalContext, type Bar } from "../src/signals";

describe("teknik bağlam", () => {
  test("sürekli yükselen seride RSI > 70, düşende < 30", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const dn = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(up)).toBeGreaterThan(70); expect(rsi(dn)).toBeLessThan(30);
  });
  test("EMA sabit seride sabittir", () => { expect(ema([5, 5, 5, 5], 3).at(-1)).toBe(5); });
  test("ATR% ve hacim oranı", () => {
    const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ ts: i, o: 100, h: 101, l: 99, c: 100, v: i === 29 ? 3 : 1 }));
    expect(atrPct(bars)).toBeCloseTo(2, 6);
    expect(volRatio(bars)).toBeCloseTo(3, 6);
    expect(technicalContext(bars, 0).trend).toBe("yatay");
  });
});

const mk = (o: number, h: number, l: number, c: number, i = 0): Bar => ({ ts: i, o, h, l, c, v: 1 });

describe("detectSweep", () => {
  const flat = Array.from({ length: 12 }, (_, i) => mk(100, 101, 99, 100, i));
  test("dibi delip içeri yeşil kapanış → sinyal", () => {
    const s = detectSweep([...flat, mk(99.5, 100.2, 98.5, 99.9, 12)]);
    expect(s).not.toBeNull();
    expect(s!.lo).toBe(99);
    expect(s!.depthPct).toBeCloseTo(((99 - 98.5) / 99) * 100, 6);
    expect(s!.mid).toBe(100);
  });
  test("derinlik eşiğin altında → yok", () => {
    expect(detectSweep([...flat, mk(99.5, 100.2, 98.9, 99.9, 12)])).toBeNull();
  });
  test("dibin altında kapanış → yok", () => {
    expect(detectSweep([...flat, mk(99.5, 100, 98, 98.8, 12)])).toBeNull();
  });
  test("kırmızı mum → yok", () => {
    expect(detectSweep([...flat, mk(100, 100.5, 98.5, 99.5, 12)])).toBeNull();
  });
  test("yetersiz veri → yok", () => {
    expect(detectSweep(flat.slice(0, 5))).toBeNull();
  });
});

describe("btcGate", () => {
  const series = (ret: number) => {
    const bars: Bar[] = [];
    for (let i = 0; i <= 16; i++) bars.push(mk(100, 100, 100, i === 16 ? 100 * (1 + ret) : 100, i));
    return bars;
  };
  test("-%2 → kapalı", () => expect(btcGate(series(-0.02)).open).toBe(false));
  test("-%0.5 → açık", () => expect(btcGate(series(-0.005)).open).toBe(true));
  test("veri yok → kapalı (güvenli taraf)", () => expect(btcGate([]).open).toBe(false));
});

describe("relStrength / target / book", () => {
  test("coin +5, BTC +1 → +4", () => {
    const coin = Array.from({ length: 17 }, (_, i) => mk(1, 1, 1, i === 16 ? 1.05 : 1, i));
    const btc = Array.from({ length: 17 }, (_, i) => mk(1, 1, 1, i === 16 ? 1.01 : 1, i));
    expect(relStrength(coin, btc)).toBeCloseTo(4, 6);
  });
  test("hedef en az giriş+%0.3, en fazla giriş+%1.5", () => {
    expect(targetPrice(100, 100.1)).toBeCloseTo(100.3, 6);
    expect(targetPrice(100, 101)).toBe(101);
    expect(targetPrice(100, 105)).toBeCloseTo(101.5, 6);
    expect(targetPrice(100, 105, 0.3, 3)).toBeCloseTo(103, 6);
  });
  test("alıcı ağır defter > 1", () => {
    expect(bookImbalance([[100, 10], [99.5, 10]], [[100.1, 2], [100.5, 2]])).toBeGreaterThan(1);
  });
});
