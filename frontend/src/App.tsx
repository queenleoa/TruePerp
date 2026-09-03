import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Code2,
  FlaskConical,
  Network,
  Wallet,
} from "lucide-react";
import { MechanismPanel } from "./components/MechanismPanel";
import { OrderTicket } from "./components/OrderTicket";
import { PreviewDialog } from "./components/PreviewDialog";
import { PriceChart } from "./components/PriceChart";
import {
  deployment,
  explorerAddressUrl,
  explorerTransactionUrl,
  formatAddress,
  hasAddressConfiguration,
  hasDeploymentTransaction,
  UNICHAIN_SEPOLIA,
} from "./config";
import { useWallet } from "./hooks/useWallet";
import { useTruePerp } from "./hooks/useTruePerp";
import type { TradeRequest } from "./lib/trading";
import { Direction, previewPosition } from "./lib/leverage";

function App() {
  const [direction, setDirection] = useState<Direction>("long");
  const [marginInput, setMarginInput] = useState("1000");
  const [leverage, setLeverage] = useState(5);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [slippageBps, setSlippageBps] = useState(50);
  const wallet = useWallet();
  const truePerp = useTruePerp({
    address: wallet.address,
    isCorrectChain: wallet.isCorrectChain,
  });
  const rawMargin = Number(marginInput.replace(/,/g, ""));
  const margin = Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : 0;
  const preview = useMemo(
    () => previewPosition(direction, margin, leverage),
    [direction, margin, leverage],
  );

  const walletLabel = wallet.pending
    ? "Waiting…"
    : wallet.address
      ? formatAddress(wallet.address)
      : "Connect wallet";

  const tradeRequest: TradeRequest = {
    direction,
    margin: marginInput,
    leverage,
    slippageBps,
  };

  const reviewPosition = (nextSlippageBps: number) => {
    const request = { ...tradeRequest, slippageBps: nextSlippageBps };
    setSlippageBps(nextSlippageBps);
    truePerp.clearFeedback();
    setDialogOpen(true);
    void truePerp.requestQuote(request);
  };

  const openPosition = async () => {
    await truePerp.open(tradeRequest);
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="TruePerp home">
          <span className="trueperp-logo-crop" aria-hidden="true">
            <img src="/brand/trueperp-logo.jpg" alt="" />
          </span>
          <small>physical perps</small>
        </a>

        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="active" href="#trade">Trade</a>
          <a href="#mechanism">Mechanism</a>
          <a
            href="https://github.com/queenleoa/TruePerp/blob/main/WHITEPAPER.md"
            target="_blank"
            rel="noreferrer"
          >
            Research <ArrowUpRight size={12} />
          </a>
        </nav>

        <div className="header-actions">
          <div className={`network-indicator ${wallet.isCorrectChain ? "connected" : ""}`}>
            <span />
            <Network size={14} />
            <span>{UNICHAIN_SEPOLIA.name}</span>
          </div>
          <button
            className="wallet-button"
            disabled={wallet.pending}
            onClick={wallet.address && !wallet.isCorrectChain ? wallet.switchNetwork : wallet.connect}
            type="button"
          >
            <Wallet size={15} />
            {wallet.address && !wallet.isCorrectChain ? "Switch network" : walletLabel}
          </button>
        </div>
      </header>

      <div className={`environment-banner ${hasAddressConfiguration ? "configured" : "demo"}`}>
        <div>
          {hasAddressConfiguration ? <CheckCircle2 size={14} /> : <FlaskConical size={14} />}
          <strong>{hasAddressConfiguration ? "Live testnet" : "Interactive demo"}</strong>
          <span>
            {hasAddressConfiguration
              ? `TrueETH / TrueUSDC live on testnet · Router ${formatAddress(deployment.router)} · wallet transactions enabled`
              : "Unbacked TrueETH / TrueUSDC demo assets · deployment configuration missing"}
          </span>
        </div>
        {hasAddressConfiguration && (
          <a
            href={hasDeploymentTransaction
              ? explorerTransactionUrl(deployment.transaction)
              : explorerAddressUrl(deployment.router)}
            target="_blank"
            rel="noreferrer"
          >
            {hasDeploymentTransaction ? "View deployment tx" : "View router"}
            <ArrowUpRight size={12} />
          </a>
        )}
      </div>

      {wallet.error && <div className="wallet-error" role="alert">{wallet.error}</div>}

      <main className="trade-layout" id="top">
        <section className="trading-workspace" id="trade">
          <div className="market-kicker">
            <span>TrueETH perpetual demo</span>
            <strong>Up to 10×</strong>
            <small>mock base/quote inventory · no expiry · zero demo carry</small>
          </div>
          <div className="trading-grid">
            <PriceChart />
            <OrderTicket
              correctChain={wallet.isCorrectChain}
              direction={direction}
              leverage={leverage}
              marginInput={marginInput}
              onConnect={wallet.connect}
              onDirectionChange={setDirection}
              onLeverageChange={setLeverage}
              onMarginChange={setMarginInput}
              onPreview={reviewPosition}
              onSwitchNetwork={wallet.switchNetwork}
              transactionPending={truePerp.isBusy}
              walletAddress={wallet.address}
              demoAssets={{
                snapshot: truePerp.snapshot,
                loading: truePerp.isBusy,
                pendingToken:
                  truePerp.action === "claimNativeEth"
                    ? "nativeEth"
                    : truePerp.action === "claimTrueEth"
                    ? "trueEth"
                    : truePerp.action === "claimTrueUsdc"
                      ? "trueUsdc"
                      : null,
                error: dialogOpen ? "" : truePerp.error,
                transactionHash: truePerp.lastFaucetReceipt?.hash,
                transactionAsset: truePerp.lastFaucetReceipt?.token,
                onClaim: (token) => void truePerp.claim(token),
                onClaimGasEth: () => void truePerp.claimGasEth(),
                onRefresh: () => void truePerp.refresh(),
              }}
            />
          </div>
        </section>

        <div id="mechanism">
          <MechanismPanel direction={direction} preview={preview} />
        </div>
      </main>

      <footer className="site-footer">
        <div>
          <span>TRUEPERP / HACKATHON PROTOTYPE</span>
          <small>Not audited · unbacked test assets · demo values only</small>
        </div>
        <nav aria-label="Project links">
          <a href="https://github.com/queenleoa/TruePerp#readme" target="_blank" rel="noreferrer">
            <BookOpen size={14} /> Docs
          </a>
          <a href="https://github.com/queenleoa/TruePerp" target="_blank" rel="noreferrer">
            <Code2 size={14} /> Source
          </a>
        </nav>
      </footer>

      <PreviewDialog
        direction={direction}
        error={truePerp.error}
        loadingQuote={truePerp.action === "quote"}
        onClose={() => {
          if (truePerp.action !== "trade") {
            setDialogOpen(false);
            truePerp.clearFeedback();
          }
        }}
        onOpen={() => void openPosition()}
        onRetryQuote={() => void truePerp.requestQuote(tradeRequest)}
        open={dialogOpen}
        progress={truePerp.progress}
        preview={preview}
        quote={truePerp.quote}
        receipt={truePerp.lastTrade}
        submitting={truePerp.action === "trade"}
      />
    </div>
  );
}

export default App;
