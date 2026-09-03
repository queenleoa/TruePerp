import { describe, expect, it } from "vitest";
import {
  clampLeverage,
  ENTRY_PRICE,
  formatQuote,
  POOL_FEE_RATE,
  previewPosition,
} from "./leverage";

describe("physical leverage preview", () => {
  it("uses the demo pool's 2,000 TrueUSDC per TrueETH initialization price", () => {
    expect(ENTRY_PRICE).toBe(2_000);
  });

  it("constructs a 10x long from margin plus quote debt", () => {
    const position = previewPosition("long", 1_000, 10);

    expect(position.borrowValue).toBeCloseTo(8_737.1, 1);
    expect(position.collateralValue).toBeCloseTo(9_707.88, 1);
    expect(position.realizedLeverage).toBeCloseTo(10);
    expect(position.openingLtv).toBeCloseTo(0.9);
    expect(position.equityValue).toBeCloseTo(970.79, 1);
    expect(position.baseExposure).toBeCloseTo(position.collateralValue / ENTRY_PRICE);
    expect(position.estimatedPoolFee).toBeCloseTo(position.swapInput * POOL_FEE_RATE);
    expect(position.liquidationPrice).toBeLessThan(ENTRY_PRICE);
  });

  it("constructs a 9x short as borrowed base against quote collateral", () => {
    const position = previewPosition("short", 1_000, 9);

    expect(position.borrowValue).toBeCloseTo(8_763.39, 1);
    expect(position.collateralValue).toBeCloseTo(9_737.1, 1);
    expect(position.realizedLeverage).toBeCloseTo(9);
    expect(position.openingLtv).toBeCloseTo(0.9);
    expect(position.debtBase).toBeCloseTo(position.borrowValue / ENTRY_PRICE);
    expect(position.receiveEstimate).toBeLessThan(position.borrowValue);
    expect(position.liquidationPrice).toBeGreaterThan(ENTRY_PRICE);
  });

  it("uses direction-specific product limits", () => {
    expect(clampLeverage("long", 20)).toBe(10);
    expect(clampLeverage("short", 20)).toBe(9);
    expect(clampLeverage("long", 0)).toBe(1.1);
    expect(clampLeverage("short", 0)).toBe(1);
    expect(clampLeverage("long", Number.NaN)).toBe(1.1);
  });

  it("keeps fee-adjusted targets below the 90.25% opening cap", () => {
    for (const direction of ["long", "short"] as const) {
      const position = previewPosition(direction, 2_500, 100);
      expect(position.openingLtv).toBeCloseTo(0.9);
      expect(position.openingLtv).toBeLessThan(0.9025);
    }
  });

  it("handles invalid margin and price without non-finite output", () => {
    const position = previewPosition("long", Number.NaN, 5, 0);
    expect(position.margin).toBe(0);
    expect(position.borrowValue).toBe(0);
    expect(position.liquidationPrice).toBe(0);
    expect(position.realizedLeverage).toBe(0);
  });

  it("labels quote values as mock TrueUSDC rather than dollars", () => {
    expect(formatQuote(1_000, 0)).toBe("1,000 tUSDC");
  });
});
