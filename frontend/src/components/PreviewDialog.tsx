import { useEffect, useRef } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { Direction, formatNumber, formatUsd, PositionPreview } from "../lib/leverage";

interface PreviewDialogProps {
  open: boolean;
  onClose: () => void;
  direction: Direction;
  preview: PositionPreview;
}

export function PreviewDialog({ open, onClose, direction, preview }: PreviewDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [onClose, open]);

  if (!open) return null;
  const long = direction === "long";

  return (
    <div className="dialog-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="preview-title"
        aria-describedby="preview-description"
        aria-modal="true"
        className="preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <button
          aria-label="Close preview"
          className="dialog-close icon-button"
          onClick={onClose}
          ref={closeRef}
          title="Close preview"
          type="button"
        >
          <X size={18} />
        </button>
        <span className="eyebrow">Transaction preview</span>
        <h2 id="preview-title">Your {preview.leverage.toFixed(1)}× ETH {direction}</h2>
        <p id="preview-description">
          One transaction would transform your margin into the following physical
          position. Nothing has been submitted.
        </p>

        <div className={`preview-route ${direction}`}>
          <div>
            <small>Margin</small>
            <strong>{formatUsd(preview.margin, 0)} USDC</strong>
          </div>
          <ArrowRight size={20} />
          <div>
            <small>Atomic swap + borrow</small>
            <strong>{long ? "buy WETH" : "sell WETH"}</strong>
          </div>
          <ArrowRight size={20} />
          <div>
            <small>Position</small>
            <strong>
              {long
                ? `${formatNumber(preview.baseExposure, 3)} WETH`
                : `${formatUsd(preview.collateralValue, 0)} USDC`}
            </strong>
          </div>
        </div>

        <ul className="preview-checks">
          <li><Check size={15} /> Fee-adjusted target leverage: {preview.realizedLeverage.toFixed(2)}×*</li>
          <li><Check size={15} /> Opening LTV: {(preview.openingLtv * 100).toFixed(2)}%</li>
          <li><Check size={15} /> Swap/poke-driven gradual liquidation</li>
        </ul>

        <div className="demo-block">
          <strong>Preview only</strong>
          <span>
            Add verified Unichain Sepolia addresses and a production quote adapter
            before adding calldata encoding or contract writes. *Price impact excluded.
          </span>
        </div>

        <button className="dialog-done" onClick={onClose} type="button">Back to order</button>
      </section>
    </div>
  );
}
