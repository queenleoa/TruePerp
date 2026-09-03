import {
  ArrowUpRight,
  Check,
  Coins,
  Droplets,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { explorerTransactionUrl } from "../config";
import type { DemoToken, WalletSnapshot } from "../lib/trading";

interface DemoAssetsProps {
  walletAddress: string;
  correctChain: boolean;
  snapshot: WalletSnapshot | null;
  loading: boolean;
  pendingToken: DemoToken | null;
  error: string;
  transactionHash?: string;
  onConnect: () => void;
  onSwitchNetwork: () => void;
  onClaim: (token: DemoToken) => void;
  onRefresh: () => void;
}

interface AssetRowProps {
  symbol: "tETH" | "tUSDC";
  name: string;
  balance: string;
  amount: string;
  claimed: boolean;
  pending: boolean;
  disabled: boolean;
  onClaim: () => void;
}

function readableBalance(value: string, maximumFractionDigits: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(parsed);
}

function AssetRow({
  symbol,
  name,
  balance,
  amount,
  claimed,
  pending,
  disabled,
  onClaim,
}: AssetRowProps) {
  return (
    <div className="demo-asset-row">
      <span className={`demo-token-mark ${symbol === "tETH" ? "eth" : "usdc"}`}>
        {symbol === "tETH" ? "Ξ" : "$"}
      </span>
      <span className="demo-token-copy">
        <strong>{name}</strong>
        <small>
          {readableBalance(balance, symbol === "tETH" ? 4 : 2)} {symbol} balance
        </small>
      </span>
      <button
        className={claimed ? "claimed" : ""}
        disabled={disabled || claimed || pending}
        onClick={onClaim}
        type="button"
      >
        {pending ? (
          <><RefreshCw className="spin" size={12} /> Confirming…</>
        ) : claimed ? (
          <><Check size={12} /> Claimed</>
        ) : (
          <><Droplets size={12} /> Claim {amount} {symbol}</>
        )}
      </button>
    </div>
  );
}

export function DemoAssets({
  walletAddress,
  correctChain,
  snapshot,
  loading,
  pendingToken,
  error,
  transactionHash,
  onConnect,
  onSwitchNetwork,
  onClaim,
  onRefresh,
}: DemoAssetsProps) {
  const blocked = !walletAddress || !correctChain || loading;
  const action = !walletAddress ? onConnect : !correctChain ? onSwitchNetwork : undefined;

  return (
    <section className="demo-assets" aria-label="TruePerp demo token faucets">
      <div className="demo-assets-heading">
        <span><Coins size={13} /> Demo token faucet</span>
        {walletAddress && (
          <button
            aria-label="Refresh balances"
            className="demo-refresh"
            disabled={loading}
            onClick={onRefresh}
            title="Refresh balances"
            type="button"
          >
            <RefreshCw className={loading ? "spin" : ""} size={12} />
          </button>
        )}
      </div>

      <p>One free allocation per wallet. These are unbacked test tokens.</p>

      <AssetRow
        amount={snapshot?.formatted.trueUsdcFaucetAmount || "10,000"}
        balance={snapshot?.formatted.trueUsdcBalance || "0"}
        claimed={snapshot?.trueUsdcClaimed || false}
        disabled={blocked}
        name="TrueUSDC"
        onClaim={() => onClaim("trueUsdc")}
        pending={pendingToken === "trueUsdc"}
        symbol="tUSDC"
      />
      <AssetRow
        amount={snapshot?.formatted.trueEthFaucetAmount || "5"}
        balance={snapshot?.formatted.trueEthBalance || "0"}
        claimed={snapshot?.trueEthClaimed || false}
        disabled={blocked}
        name="TrueETH"
        onClaim={() => onClaim("trueEth")}
        pending={pendingToken === "trueEth"}
        symbol="tETH"
      />

      {!walletAddress || !correctChain ? (
        <button className="demo-wallet-action" onClick={action} type="button">
          <Wallet size={12} />
          {!walletAddress ? "Connect MetaMask to claim" : "Switch to Unichain Sepolia"}
        </button>
      ) : (
        <div className="demo-gas-row">
          <span>
            Gas: {snapshot ? readableBalance(snapshot.formatted.nativeBalance, 5) : "—"} ETH
          </span>
          <a
            href="https://developers.uniswap.org/docs/unichain/tools/faucets"
            target="_blank"
            rel="noreferrer"
          >
            Need test ETH? <ArrowUpRight size={10} />
          </a>
        </div>
      )}

      {error && <div className="demo-assets-error" role="alert">{error}</div>}
      {transactionHash && (
        <a
          className="demo-assets-receipt"
          href={explorerTransactionUrl(transactionHash)}
          target="_blank"
          rel="noreferrer"
        >
          Faucet confirmed · view transaction <ArrowUpRight size={10} />
        </a>
      )}
    </section>
  );
}
