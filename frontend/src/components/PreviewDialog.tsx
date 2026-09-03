import { useEffect, useRef } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { formatUnits } from "viem";
import { explorerTransactionUrl } from "../config";
import { Direction, formatNumber, PositionPreview } from "../lib/leverage";
import type {
  LiveTradeQuote,
  OpenTradeReceipt,
  TransactionProgress,
} from "../lib/trading";

interface PreviewDialogProps {
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  onRetryQuote: () => void;
  direction: Direction;
  preview: PositionPreview;
  quote: LiveTradeQuote | null;
  receipt: OpenTradeReceipt | null;
  progress: TransactionProgress | null;
  loadingQuote: boolean;
  submitting: boolean;
  error: string;
}

function displayTokenAmount(value: string, maximumFractionDigits = 5) {
  return formatNumber(Number(value), maximumFractionDigits);
}

export function PreviewDialog({
  open,
  onClose,
  onOpen,
  onRetryQuote,
  direction,
  preview,
  quote,
  receipt,
  progress,
  loadingQuote,
  submitting,
  error,
}: PreviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose, open, submitting]);

  if (!open) return null;
  const long = direction === "long";
  const expectedLeverage = quote ? quote.expectedLeverageBps / 10_000 : 0;
  const expectedLtv = quote ? quote.expectedOpeningLtvBps / 100 : 0;
  const requestedBorrow = quote
    ? formatUnits(quote.requestedBorrowAmount, long ? 6 : 18)
    : "0";

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={() => !submitting && onClose()}
      role="presentation"
    >
      <section
        aria-labelledby="preview-title"
        aria-describedby="preview-description"
        aria-modal="true"
        className="preview-dialog live-preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <button
          aria-label="Close review"
          className="dialog-close icon-button"
          disabled={submitting}
          onClick={onClose}
          ref={closeRef}
          title="Close review"
          type="button"
        >
          <X size={18} />
        </button>

        {receipt ? (
          <div className="trade-success">
            <span className="success-mark"><Check size={24} /></span>
            <span className="eyebrow">Position opened</span>
            <h2 id="preview-title">Your TrueETH {direction} is live.</h2>
            <p id="preview-description">
              The router opened the physical collateral-and-debt position on
              Unichain Sepolia. Its identifier is retained below for the demo.
            </p>
            <dl className="receipt-details">
              <div><dt>Executed leverage</dt><dd>{(receipt.quote.expectedLeverageBps / 10_000).toFixed(2)}×</dd></div>
              <div><dt>Opening LTV</dt><dd>{(receipt.quote.expectedOpeningLtvBps / 100).toFixed(2)}%</dd></div>
              <div><dt>Position ID</dt><dd>{receipt.positionId.slice(0, 12)}…{receipt.positionId.slice(-8)}</dd></div>
            </dl>
            <a
              className="dialog-transaction-link"
              href={explorerTransactionUrl(receipt.hash)}
              target="_blank"
              rel="noreferrer"
            >
              View confirmed transaction on Uniscan <ArrowUpRight size={13} />
            </a>
            <button className="dialog-done" onClick={onClose} type="button">Done</button>
          </div>
        ) : (
          <>
            <span className="eyebrow">Live transaction review</span>
            <h2 id="preview-title">Your {preview.leverage.toFixed(1)}× TrueETH {direction}</h2>
            <p id="preview-description">
              The target comes from the slider. The executable values below are
              recalculated against the deployed Uniswap v4 pool before signing.
            </p>

            {loadingQuote && !quote ? (
              <div className="quote-loading" role="status">
                <LoaderCircle className="spin" size={22} />
                <strong>Solving the live debt leg</strong>
                <span>Reading pool price, quoting impact, and checking safe opening LTV…</span>
              </div>
            ) : quote ? (
              <>
                <div className={`preview-route ${direction}`}>
                  <div>
                    <small>Margin</small>
                    <strong>{displayTokenAmount(quote.formatted.margin, 2)} tUSDC</strong>
                  </div>
                  <ArrowRight size={20} />
                  <div>
                    <small>{long ? "Borrow tUSDC + buy" : "Borrow + sell tETH"}</small>
                    <strong>
                      {displayTokenAmount(quote.formatted.borrowAmount)} {long ? "tUSDC" : "tETH"}
                    </strong>
                  </div>
                  <ArrowRight size={20} />
                  <div>
                    <small>Live swap output</small>
                    <strong>
                      {displayTokenAmount(quote.formatted.amountOut)} {quote.outputSymbol}
                    </strong>
                  </div>
                </div>

                <div className="live-quote-grid">
                  <div><span>Pool mark</span><strong>{displayTokenAmount(quote.spotPriceQuotePerBase, 2)} tUSDC/tETH</strong></div>
                  <div><span>Minimum received</span><strong>{displayTokenAmount(quote.formatted.minSwapOutput)} {quote.outputSymbol}</strong></div>
                  <div><span>Expected leverage</span><strong>{expectedLeverage.toFixed(2)}×</strong></div>
                  <div><span>Expected opening LTV</span><strong>{expectedLtv.toFixed(2)}%</strong></div>
                </div>

                {quote.borrowWasAdjusted && (
                  <div className="quote-adjustment">
                    <ShieldCheck size={15} />
                    <span>
                      Pool impact changed the analytical debt from {displayTokenAmount(requestedBorrow)} to {displayTokenAmount(quote.formatted.borrowAmount)} {long ? "tUSDC" : "tETH"}. The live plan targets at most 90.00% LTV, below the 90.25% admission cap.
                    </span>
                  </div>
                )}

                <ul className="preview-checks">
                  <li><Check size={15} /> Live v4 quote at block {quote.blockNumber.toString()}</li>
                  <li><Check size={15} /> Exact tUSDC margin approval only when required</li>
                  <li><Check size={15} /> Hook admission preflight before signing the open transaction</li>
                </ul>
              </>
            ) : null}

            {progress && (
              <div className="transaction-progress" role="status">
                <LoaderCircle className={submitting ? "spin" : ""} size={16} />
                <span>{progress.message}</span>
                {progress.hash && (
                  <a href={explorerTransactionUrl(progress.hash)} target="_blank" rel="noreferrer">
                    View <ArrowUpRight size={10} />
                  </a>
                )}
              </div>
            )}

            {error && (
              <div className="dialog-error" role="alert">
                <CircleAlert size={15} /> <span>{error}</span>
              </div>
            )}

            <div className="demo-block live-block">
              <strong>Real testnet transaction</strong>
              <span>
                Mock assets only. MetaMask may request one exact-margin approval,
                followed by the position-open transaction. Native test ETH pays gas.
              </span>
            </div>

            {quote ? (
              <button className={`dialog-submit ${direction}`} disabled={submitting || loadingQuote} onClick={onOpen} type="button">
                {submitting ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}
                {submitting ? progress?.message || "Opening position…" : `Approve if needed & open ${direction}`}
              </button>
            ) : (
              <button className="dialog-done" disabled={loadingQuote} onClick={onRetryQuote} type="button">
                {loadingQuote ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
                {loadingQuote ? "Getting live quote…" : "Retry live quote"}
              </button>
            )}
            <button className="dialog-back" disabled={submitting} onClick={onClose} type="button">Back to order</button>
          </>
        )}
      </section>
    </div>
  );
}
