export type Direction = "long" | "short";

export const ENTRY_PRICE = 3_842.6;
export const LIQUIDATION_THRESHOLD = 0.95;
export const POOL_FEE_RATE = 0.003;
export const MAX_LONG_LEVERAGE = 10;
export const MAX_SHORT_LEVERAGE = 9;
export const MIN_LONG_LEVERAGE = 1.1;
export const MIN_SHORT_LEVERAGE = 1;

export interface PositionPreview {
  direction: Direction;
  margin: number;
  leverage: number;
  borrowValue: number;
  debtBase: number;
  collateralValue: number;
  equityValue: number;
  baseExposure: number;
  directionalNotional: number;
  realizedLeverage: number;
  openingLtv: number;
  liquidationPrice: number;
  liquidationDistance: number;
  swapInput: number;
  receiveEstimate: number;
  estimatedPoolFee: number;
}

export function getMaxLeverage(direction: Direction) {
  return direction === "long" ? MAX_LONG_LEVERAGE : MAX_SHORT_LEVERAGE;
}

export function getMinLeverage(direction: Direction) {
  return direction === "long" ? MIN_LONG_LEVERAGE : MIN_SHORT_LEVERAGE;
}

export function clampLeverage(direction: Direction, leverage: number) {
  const minimum = getMinLeverage(direction);
  if (!Number.isFinite(leverage)) return minimum;
  return Math.min(Math.max(leverage, minimum), getMaxLeverage(direction));
}

/**
 * Builds an illustrative physical-position preview and solves the borrow leg
 * from target directional leverage after a 30 bp pool fee. Price impact is not
 * modeled; admission and realized balances must ultimately be checked on-chain.
 */
export function previewPosition(
  direction: Direction,
  margin: number,
  leverage: number,
  price = ENTRY_PRICE,
): PositionPreview {
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 0;
  const safeLeverage = clampLeverage(direction, leverage);
  const executionFactor = 1 - POOL_FEE_RATE;

  if (direction === "long") {
    const targetLtv = 1 - 1 / safeLeverage;
    const borrowValue =
      targetLtv > 0
        ? (targetLtv * executionFactor * safeMargin) /
          (1 - targetLtv * executionFactor)
        : 0;
    const swapInput = safeMargin + borrowValue;
    const collateralValue = swapInput * executionFactor;
    const baseExposure = price > 0 ? collateralValue / price : 0;
    const openingLtv = collateralValue > 0 ? borrowValue / collateralValue : 0;
    const equityValue = Math.max(0, collateralValue - borrowValue);
    const realizedLeverage = equityValue > 0 ? collateralValue / equityValue : 0;
    const liquidationPrice =
      baseExposure > 0
        ? borrowValue / (baseExposure * LIQUIDATION_THRESHOLD)
        : 0;

    return {
      direction,
      margin: safeMargin,
      leverage: safeLeverage,
      borrowValue,
      debtBase: 0,
      collateralValue,
      equityValue,
      baseExposure,
      directionalNotional: collateralValue,
      realizedLeverage,
      openingLtv,
      liquidationPrice,
      liquidationDistance:
        price > 0 ? Math.max(0, (price - liquidationPrice) / price) : 0,
      swapInput,
      receiveEstimate: baseExposure,
      estimatedPoolFee: swapInput * POOL_FEE_RATE,
    };
  }

  const borrowValue =
    (safeLeverage * safeMargin) /
    (1 + safeLeverage * POOL_FEE_RATE);
  const debtBase = price > 0 ? borrowValue / price : 0;
  const saleProceeds = borrowValue * executionFactor;
  const collateralValue = safeMargin + saleProceeds;
  const openingLtv = collateralValue > 0 ? borrowValue / collateralValue : 0;
  const equityValue = Math.max(0, collateralValue - borrowValue);
  const realizedLeverage = equityValue > 0 ? borrowValue / equityValue : 0;
  const liquidationPrice =
    debtBase > 0
      ? (LIQUIDATION_THRESHOLD * collateralValue) / debtBase
      : 0;

  return {
    direction,
    margin: safeMargin,
    leverage: safeLeverage,
    borrowValue,
    debtBase,
    collateralValue,
    equityValue,
    baseExposure: debtBase,
    directionalNotional: borrowValue,
    realizedLeverage,
    openingLtv,
    liquidationPrice,
    liquidationDistance:
      price > 0 ? Math.max(0, (liquidationPrice - price) / price) : 0,
    swapInput: debtBase,
    receiveEstimate: saleProceeds,
    estimatedPoolFee: borrowValue * POOL_FEE_RATE,
  };
}

export const formatUsd = (value: number, maximumFractionDigits = 2) => {
  const digits = Math.max(0, Math.min(20, Math.trunc(maximumFractionDigits)));
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
};

export const formatNumber = (value: number, maximumFractionDigits = 4) => {
  const digits = Math.max(0, Math.min(20, Math.trunc(maximumFractionDigits)));
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);
};
