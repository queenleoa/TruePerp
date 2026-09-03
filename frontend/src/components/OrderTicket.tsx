import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  CircleAlert,
  Info,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { DemoAssets } from "./DemoAssets";
import { hasAddressConfiguration } from "../config";
import type { DemoFaucetAsset, DemoToken, WalletSnapshot } from "../lib/trading";
import {
  Direction,
  ENTRY_PRICE,
  formatNumber,
  formatQuote,
  getMaxLeverage,
  getMinLeverage,
  previewPosition,
} from "../lib/leverage";

interface OrderTicketProps {
  direction: Direction;
  onDirectionChange: (direction: Direction) => void;
  marginInput: string;
  onMarginChange: (value: string) => void;
  leverage: number;
  onLeverageChange: (value: number) => void;
  walletAddress: string;
  correctChain: boolean;
  onConnect: () => void;
  onSwitchNetwork: () => void;
  onPreview: (slippageBps: number) => void;
  transactionPending: boolean;
  demoAssets: {
    snapshot: WalletSnapshot | null;
    loading: boolean;
    pendingToken: DemoFaucetAsset | null;
    error: string;
    transactionHash?: string;
    transactionAsset?: DemoFaucetAsset;
    onClaim: (token: DemoToken) => void;
    onClaimGasEth: () => void;
    onRefresh: () => void;
  };
}

export function OrderTicket({
  direction,
  onDirectionChange,
  marginInput,
  onMarginChange,
  leverage,
  onLeverageChange,
  walletAddress,
  correctChain,
  onConnect,
  onSwitchNetwork,
  onPreview,
  transactionPending,
  demoAssets,
}: OrderTicketProps) {
  const [slippage, setSlippage] = useState("0.50");
  const [showSettings, setShowSettings] = useState(false);
  const maxLeverage = getMaxLeverage(direction);
  const minLeverage = getMinLeverage(direction);
  const parsedMargin = Number(marginInput.replace(/,/g, ""));
  const marginIsValid = Number.isFinite(parsedMargin) && parsedMargin > 0;
  const margin = marginIsValid ? parsedMargin : 0;
  const parsedSlippage = Number(slippage);
  const slippageIsValid =
    Number.isFinite(parsedSlippage) && parsedSlippage > 0 && parsedSlippage <= 5;
  const preview = useMemo(
    () => previewPosition(direction, margin, leverage),
    [direction, margin, leverage],
  );

  const setDirection = (nextDirection: Direction) => {
    onDirectionChange(nextDirection);
    const nextMinimum = getMinLeverage(nextDirection);
    const nextMaximum = getMaxLeverage(nextDirection);
    if (leverage > nextMaximum) onLeverageChange(nextMaximum);
    if (leverage < nextMinimum) onLeverageChange(nextMinimum);
  };

  const actionLabel = !marginIsValid
    ? "Enter margin"
    : !walletAddress
    ? "Connect wallet"
    : !correctChain
      ? "Switch to Unichain"
      : hasAddressConfiguration
        ? "Review live position"
        : "Preview position";

  const handleAction = () => {
    if (!marginIsValid) return;
    if (!walletAddress) {
      onConnect();
      return;
    }
    if (!correctChain) {
      onSwitchNetwork();
      return;
    }
    if (!slippageIsValid) return;
    onPreview(Math.round(parsedSlippage * 100));
  };

  return (
    <section className="order-ticket" aria-label="Open a leveraged position">
      <div className="ticket-title-row">
        <div>
          <span className="eyebrow">Order ticket</span>
          <h2>Trade TrueETH</h2>
        </div>
        <button
          aria-expanded={showSettings}
          className="icon-button"
          onClick={() => setShowSettings((value) => !value)}
          title="Order settings"
          type="button"
        >
          <Settings2 size={17} />
        </button>
      </div>

      {showSettings && (
        <div className="settings-panel">
          <label htmlFor="slippage">Maximum slippage</label>
          <div className="slippage-input">
            <input
              id="slippage"
              inputMode="decimal"
              max="5"
              min="0.01"
              onChange={(event) => setSlippage(event.target.value)}
              aria-invalid={!slippageIsValid}
              value={slippage}
            />
            <span>%</span>
          </div>
          <small>
            Applied to the live v4 quote as the router's on-chain
            <code> minSwapOutput</code> bound.
          </small>
          {!slippageIsValid && <small className="field-error">Enter 0.01%–5%.</small>}
        </div>
      )}

      <div className="direction-control" role="group" aria-label="Position direction">
        <button
          aria-pressed={direction === "long"}
          className={direction === "long" ? "long active" : "long"}
          onClick={() => setDirection("long")}
          type="button"
        >
          Long
          <small>up to 10×</small>
        </button>
        <button
          aria-pressed={direction === "short"}
          className={direction === "short" ? "short active" : "short"}
          onClick={() => setDirection("short")}
          type="button"
        >
          Short
          <small>up to 9×</small>
        </button>
      </div>

      <DemoAssets
        correctChain={correctChain}
        error={demoAssets.error}
        loading={demoAssets.loading}
        onClaim={demoAssets.onClaim}
        onClaimGasEth={demoAssets.onClaimGasEth}
        onConnect={onConnect}
        onRefresh={demoAssets.onRefresh}
        onSwitchNetwork={onSwitchNetwork}
        pendingToken={demoAssets.pendingToken}
        snapshot={demoAssets.snapshot}
        transactionHash={demoAssets.transactionHash}
        transactionAsset={demoAssets.transactionAsset}
        walletAddress={walletAddress}
      />

      <div className="field-block">
        <div className="field-label">
          <label htmlFor="margin">Margin</label>
          <span>
            Balance {demoAssets.snapshot
              ? `${formatNumber(Number(demoAssets.snapshot.formatted.trueUsdcBalance), 2)} tUSDC`
              : "—"}
          </span>
        </div>
        <div className="amount-input">
          <input
            id="margin"
            aria-invalid={!marginIsValid}
            inputMode="decimal"
            min="0.01"
            onChange={(event) => onMarginChange(event.target.value)}
            value={marginInput}
          />
          <button aria-label="Select margin token" type="button">
            <span className="usdc-symbol">t$</span>
            TrueUSDC
            <ChevronDown size={14} />
          </button>
        </div>
        <span className="field-fiat">{formatQuote(margin)}</span>
        {!marginIsValid && <span className="field-error">Enter margin above zero.</span>}
      </div>

      <div className="leverage-block">
        <div className="leverage-header">
          <label htmlFor="leverage">Leverage</label>
          <output htmlFor="leverage">{leverage.toFixed(1)}×</output>
        </div>
        <input
          aria-valuetext={`${leverage.toFixed(1)} times`}
          id="leverage"
          max={maxLeverage}
          min={minLeverage}
          onChange={(event) => onLeverageChange(Number(event.target.value))}
          step="0.1"
          style={{
            "--range-progress": `${((leverage - minLeverage) / (maxLeverage - minLeverage)) * 100}%`,
          } as React.CSSProperties}
          type="range"
          value={leverage}
        />
        <div className="leverage-stops">
          {[minLeverage, 2, 3, 5, maxLeverage].map((stop) => (
            <button key={stop} onClick={() => onLeverageChange(stop)} type="button">
              {stop}×
            </button>
          ))}
        </div>
        <div className="limit-note">
          <ShieldCheck size={14} />
          <span>
            {direction === "long"
              ? "The 30 bp fee-adjusted target opens near 90% LTV, below the 90.25% admission cap. A live impact quote is still required."
              : "A 9× physical short opens near 90% LTV. Borrowed TrueETH—not total TrueUSDC held—is its directional exposure."}
          </span>
        </div>
      </div>

      <div className="order-summary">
        <div className="summary-heading">
          <span>Physical position</span>
          <span className={direction}>{direction}</span>
        </div>
        <dl>
          <div>
            <dt>{direction === "long" ? "Borrow TrueUSDC" : "Borrow TrueETH"}</dt>
            <dd>
              {direction === "long"
                ? formatQuote(preview.borrowValue)
                : `${formatNumber(preview.debtBase)} TrueETH`}
            </dd>
          </div>
          <div>
            <dt>{direction === "long" ? "Hold TrueETH" : "Hold TrueUSDC"}</dt>
            <dd>
              {direction === "long"
                ? `${formatNumber(preview.baseExposure)} TrueETH`
                : formatQuote(preview.collateralValue)}
            </dd>
          </div>
          <div>
            <dt>Opening LTV</dt>
            <dd>{(preview.openingLtv * 100).toFixed(2)}%</dd>
          </div>
          <div>
            <dt>Liquidation begins</dt>
            <dd>
              {formatQuote(preview.liquidationPrice)}
              <small>
                {direction === "long" ? "−" : "+"}
                {(preview.liquidationDistance * 100).toFixed(1)}%
              </small>
            </dd>
          </div>
          <div>
            <dt>Target leverage</dt>
            <dd>{preview.realizedLeverage.toFixed(2)}× after 30 bp fee*</dd>
          </div>
          <div>
            <dt>Entry price</dt>
            <dd>{formatQuote(ENTRY_PRICE)}</dd>
          </div>
          <div>
            <dt>Maximum slippage</dt>
            <dd>{slippageIsValid ? slippage : "—"}%</dd>
          </div>
        </dl>
      </div>

      <button
        className={`primary-action ${direction}`}
        disabled={!marginIsValid || !slippageIsValid || transactionPending}
        onClick={handleAction}
        type="button"
      >
        <Sparkles size={17} />
        {transactionPending ? "Please wait…" : actionLabel}
      </button>

      <div className="execution-note">
        {hasAddressConfiguration ? <Info size={14} /> : <CircleAlert size={14} />}
        <span>
          {hasAddressConfiguration
            ? "Live testnet mode: the review uses the deployed v4 Quoter, then requests an exact-margin approval and opens through the TruePerp router."
            : "Demo mode: no complete TruePerp market configuration is present and no transaction can be sent."}
        </span>
      </div>

      <div className="atomic-route">
        <ArrowDownUp size={13} />
        <span>One atomic v4 transaction · no recursive loans</span>
      </div>
    </section>
  );
}
