import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Box,
  CircleGauge,
  Droplets,
  Landmark,
  Repeat2,
  Shield,
  WalletCards,
  Zap,
} from "lucide-react";
import {
  Direction,
  formatNumber,
  formatQuote,
  LIQUIDATION_THRESHOLD,
  PositionPreview,
} from "../lib/leverage";

type ExplainerView = "open" | "liquidate";

interface MechanismPanelProps {
  direction: Direction;
  preview: PositionPreview;
}

function FlowArrow({ label }: { label?: string }) {
  return (
    <div className="flow-arrow" aria-hidden="true">
      {label && <span>{label}</span>}
      <ArrowRight size={20} strokeWidth={1.6} />
    </div>
  );
}

export function MechanismPanel({ direction, preview }: MechanismPanelProps) {
  const [view, setView] = useState<ExplainerView>("open");
  const long = direction === "long";
  const admissionCap = 0.9025;
  const ltvHeadroom = Math.max(
    0,
    (LIQUIDATION_THRESHOLD - preview.openingLtv) * 100,
  );
  const ownedAsset = long
    ? `${formatNumber(preview.baseExposure, 3)} tETH worth ${formatQuote(preview.collateralValue)}`
    : `${formatQuote(preview.collateralValue)} after the tETH sale`;
  const debtAsset = long
    ? `${formatQuote(preview.borrowValue)} from the quote vault`
    : `${formatNumber(preview.debtBase, 3)} tETH (worth ${formatQuote(preview.borrowValue)}) from the base vault`;
  const directionalExposure = long
    ? formatQuote(preview.directionalNotional)
    : `${formatNumber(preview.debtBase, 3)} tETH, worth ${formatQuote(preview.directionalNotional)}`;

  return (
    <aside className="mechanism-panel" aria-label="How TruePerp leverage works">
      <div className="mechanism-heading">
        <div>
          <span className="eyebrow">Under the hood</span>
          <h2>Leverage you can point to.</h2>
        </div>
        <span className="no-keeper"><Shield size={13} /> no privileged keeper</span>
      </div>

      <p className="mechanism-intro">
        TruePerp turns TrueLend's borrow-and-swap route into a trading product:
        a real collateral-and-debt position, not a synthetic bet against an LP
        vault. Ordinary Uniswap flow—or a permissionless poke—advances its unwind.
      </p>

      <div className="protocol-lineage" aria-label="TrueLend powers TruePerp leverage">
        <span className="truelend-logo-crop" aria-hidden="true">
          <img src="/brand/truelend-logo.png" alt="" />
        </span>
        <ArrowRight size={15} strokeWidth={1.5} aria-hidden="true" />
        <span><strong>isolated credit</strong> becomes physical leveraged exposure</span>
      </div>

      <div className="explainer-tabs" role="group" aria-label="Mechanism stage">
        <button
          aria-pressed={view === "open"}
          className={view === "open" ? "active" : ""}
          onClick={() => setView("open")}
          type="button"
        >
          01 · Open
        </button>
        <button
          aria-pressed={view === "liquidate"}
          className={view === "liquidate" ? "active" : ""}
          onClick={() => setView("liquidate")}
          type="button"
        >
          02 · If risk rises
        </button>
      </div>

      {view === "open" ? (
        <>
          <div className={`sketch-canvas ${direction}`}>
          <span className="sketch-caption">one atomic PoolManager unlock</span>
          <svg className="rough-lines" viewBox="0 0 480 350" preserveAspectRatio="none" aria-hidden="true">
            <path d="M118 69 C150 61, 168 70, 193 80" />
            <path d="M119 72 C151 65, 171 73, 192 83" />
            <path d="M357 69 C328 61, 307 69, 284 80" />
            <path d="M357 72 C327 65, 305 73, 285 83" />
            <path d="M239 133 C245 159, 235 171, 241 194" />
            <path d="M243 133 C248 159, 239 173, 244 193" />
            <path d="M239 271 C241 287, 241 295, 242 310" />
          </svg>

          <div className="sketch-node trader-node">
            <WalletCards size={18} />
            <small>you bring</small>
            <strong>{formatQuote(preview.margin, 0)}</strong>
            <span>TrueUSDC margin</span>
          </div>

          <div className="sketch-node vault-node">
            <Landmark size={18} />
            <small>{long ? "Quote vault lends" : "Base vault lends"}</small>
            <strong>
              {long
                ? formatQuote(preview.borrowValue, 0)
                : `${formatNumber(preview.debtBase, 3)} TrueETH`}
            </strong>
            <span>{long ? "TrueUSDC debt" : `≈ ${formatQuote(preview.borrowValue, 0)}`}</span>
          </div>

          <div className="sketch-node router-node">
            <Zap size={18} />
            <small>TruePerp Router</small>
            <strong>{preview.leverage.toFixed(1)}× {direction}</strong>
            <span>combines margin + debt</span>
          </div>

          <div className="hand-note note-atomic">flash accounting,<br />not recursive looping</div>

          <div className="sketch-node pool-node">
            <Repeat2 size={18} />
            <small>Uniswap v4 swaps</small>
            <strong>{long ? "TrueUSDC → TrueETH" : "TrueETH → TrueUSDC"}</strong>
            <span>the same TrueETH / TrueUSDC pool</span>
          </div>

          <div className="down-arrow" aria-hidden="true"><ArrowDown size={22} /></div>

          <div className="position-paper">
            <span className="paper-pin" aria-hidden="true" />
            <div className="paper-title"><Box size={16} /> PHYSICAL POSITION</div>
            <div className="balance-line owns">
              <span>OWNS</span>
              <strong>
                {long
                  ? `${formatNumber(preview.baseExposure, 3)} TrueETH`
                  : formatQuote(preview.collateralValue, 0)}
              </strong>
            </div>
            <div className="balance-line owes">
              <span>OWES</span>
              <strong>
                {long
                  ? formatQuote(preview.borrowValue, 0)
                  : `${formatNumber(preview.debtBase, 3)} TrueETH`}
              </strong>
            </div>
            <div className="paper-equity">
              estimated equity {formatQuote(preview.equityValue, 0)} at entry*
            </div>
          </div>
          <div className="hand-note note-result">
            this is the {direction} ↓<br />not a pool-side IOU
          </div>
          </div>

          <section className="mechanism-math-card" aria-label="Leverage calculation">
            <div className="mechanism-math-heading">
              <div>
                <span>Why the slider produces {preview.leverage.toFixed(1)}×</span>
                <h3>Debt is solved from the leverage target.</h3>
              </div>
              <strong>{preview.realizedLeverage.toFixed(2)}×</strong>
            </div>

            <p className="mechanism-math-definition">
              Leverage is directional notional divided by equity—not the amount
              borrowed divided by margin. For a {direction}, directional notional
              is {long ? "the value of all tETH owned" : "the value of the borrowed tETH sold short"}.
            </p>

            <ol className="mechanism-math-ledger">
              <li>
                <span>Trader margin</span>
                <strong>{formatQuote(preview.margin)}</strong>
                <small>your capital, deposited as tUSDC</small>
              </li>
              <li>
                <span>Vault debt</span>
                <strong>{debtAsset}</strong>
                <small>{long ? "the quote vault lends tUSDC" : "the base vault lends tETH"}</small>
              </li>
              <li>
                <span>After the pool swap</span>
                <strong>{ownedAsset}</strong>
                <small>estimated after the 30 bp fee; price impact is not included</small>
              </li>
              <li>
                <span>Entry equity</span>
                <strong>
                  {formatQuote(preview.collateralValue)} − {formatQuote(preview.borrowValue)} = {formatQuote(preview.equityValue)}
                </strong>
                <small>owned collateral value minus marked debt value</small>
              </li>
            </ol>

            <div className="mechanism-math-equation">
              <span>{long ? "owned tETH value" : "borrowed tETH value"} ÷ equity</span>
              <strong>
                {directionalExposure} ÷ {formatQuote(preview.equityValue)} = {preview.realizedLeverage.toFixed(2)}×
              </strong>
            </div>

            <div className="mechanism-math-risk">
              <div className="mechanism-math-risk-copy">
                <span>Opening LTV = debt value ÷ collateral value</span>
                <strong>
                  {formatQuote(preview.borrowValue)} ÷ {formatQuote(preview.collateralValue)} = {(preview.openingLtv * 100).toFixed(2)}%
                </strong>
              </div>
              <div className="mechanism-math-risk-track" aria-label={`Opening LTV ${(preview.openingLtv * 100).toFixed(2)} percent`}>
                <i
                  className="mechanism-math-risk-fill"
                  style={{ width: `${Math.min(100, preview.openingLtv * 100)}%` }}
                />
                <i className="mechanism-math-cap-marker" style={{ left: `${admissionCap * 100}%` }} />
                <i className="mechanism-math-lt-marker" style={{ left: `${LIQUIDATION_THRESHOLD * 100}%` }} />
              </div>
              <div className="mechanism-math-risk-labels">
                <span>current {(preview.openingLtv * 100).toFixed(2)}%</span>
                <span>admission cap 90.25%</span>
                <span>liquidation threshold 95%</span>
              </div>
              <p>
                The protocol admits a new position only at or below 90.25% LTV
                (95% of the 95% liquidation threshold). This preview therefore
                has {ltvHeadroom.toFixed(2)} percentage points before gradual
                liquidation becomes eligible.
              </p>
            </div>

            <div className="mechanism-math-roles">
              <span><b>Vault</b> lends the asset and records debt.</span>
              <span><b>Uniswap pool</b> executes entry, exit, and unwind swaps.</span>
              <span><b>Hook</b> enforces admission and advances gradual liquidation.</span>
            </div>
          </section>
        </>
      ) : (
        <div className={`liquidation-canvas ${direction}`}>
          <div className="risk-scale">
            <div className="risk-price">
              <small>TrueETH price moves against your {direction}</small>
              <strong>{long ? "price ↓" : "price ↑"}</strong>
            </div>
            <div className="risk-track">
              <span className="safe-zone">healthy</span>
              <span className="trigger-mark" style={{ left: "67%" }}>
                <i />
                95% LT
              </span>
              <span className="danger-zone">risk</span>
            </div>
            <div className="risk-readout">
              <span>opens at {(preview.openingLtv * 100).toFixed(2)}% LTV</span>
              <strong>starts near {formatQuote(preview.liquidationPrice, 0)}</strong>
            </div>
          </div>

          <div className="liquidation-flow">
            <div className="liq-node">
              <CircleGauge size={19} />
              <span>01</span>
              <strong>Hook observes</strong>
              <small>the pool crosses a pre-indexed risk range</small>
            </div>
            <FlowArrow label="swap or public poke" />
            <div className="liq-node featured">
              <Droplets size={19} />
              <span>02</span>
              <strong>One small chunk</strong>
              <small>
                {long ? "TrueETH collateral is sold" : "TrueUSDC buys TrueETH"}
              </small>
            </div>
            <FlowArrow label="proceeds" />
            <div className="liq-node">
              <Landmark size={19} />
              <span>03</span>
              <strong>Debt shrinks</strong>
              <small>the isolated lending vault is repaid</small>
            </div>
          </div>

          <div className="hand-note liq-note">
            repeat only while price stays in danger → far edge enables the bounded backstop
          </div>

          <div className="keeper-comparison">
            <div><s>keeper race</s><span>none</span></div>
            <div><s>one-shot auction</s><span>paced chunks</span></div>
            <div><s>separate liquidator venue</s><span>same v4 pool</span></div>
          </div>
        </div>
      )}

      <div className="truth-strip">
        <span>*Includes an illustrative 30 bp pool fee; excludes price impact.</span>
        <strong>Pool = execution venue · TrueLend vault = lender · Hook = risk engine</strong>
      </div>
    </aside>
  );
}
