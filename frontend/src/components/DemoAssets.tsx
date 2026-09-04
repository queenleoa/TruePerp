import {
  ArrowUpRight,
  Check,
  Coins,
  Droplets,
  RefreshCw,
  Wallet,
} from "lucide-react";
import {
  explorerTransactionUrl,
  hasGaslessNativeFaucetConfiguration,
  hasNativeEthFaucetConfiguration,
} from "../config";
import type { DemoFaucetAsset, DemoToken, WalletSnapshot } from "../lib/trading";

interface DemoAssetsProps {
  walletAddress: string;
  correctChain: boolean;
  snapshot: WalletSnapshot | null;
  loading: boolean;
  pendingToken: DemoFaucetAsset | null;
  error: string;
  transactionHash?: string;
  transactionAsset?: DemoFaucetAsset;
  onConnect: () => void;
  onSwitchNetwork: () => void;
  onClaim: (token: DemoToken) => void;
  onClaimGasEth: () => void;
  onRefresh: () => void;
}

interface AssetRowProps {
  symbol: "ETH" | "tETH" | "tUSDC";
  name: string;
  balance: string;
  amount: string;
  claimed: boolean;
  pending: boolean;
  disabled: boolean;
  onClaim: () => void;
  detail?: string;
  claimLabel?: string;
  unavailable?: boolean;
  exhausted?: boolean;
  pendingLabel?: string;
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
  detail,
  claimLabel,
  unavailable = false,
  exhausted = false,
  pendingLabel = "Confirming…",
}: AssetRowProps) {
  return (
    <div className="demo-asset-row">
      <span className={`demo-token-mark ${symbol === "ETH" ? "gas" : symbol === "tETH" ? "eth" : "usdc"}`}>
        {symbol === "tUSDC" ? "$" : "Ξ"}
      </span>
      <span className="demo-token-copy">
        <strong>{name}</strong>
        <small>
          {readableBalance(balance, symbol === "tUSDC" ? 2 : 5)} {symbol} balance
          {detail ? ` · ${detail}` : ""}
        </small>
      </span>
      <button
        className={claimed ? "claimed" : ""}
        disabled={disabled || claimed || pending || unavailable || exhausted}
        onClick={onClaim}
        type="button"
      >
        {pending ? (
          <><RefreshCw className="spin" size={12} /> {pendingLabel}</>
        ) : claimed ? (
          <><Check size={12} /> Claimed</>
        ) : unavailable ? (
          <>Not configured</>
        ) : exhausted ? (
          <>Faucet empty</>
        ) : (
          <><Droplets size={12} /> {claimLabel || `Claim ${amount} ${symbol}`}</>
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
  transactionAsset,
  onConnect,
  onSwitchNetwork,
  onClaim,
  onClaimGasEth,
  onRefresh,
}: DemoAssetsProps) {
  const blocked = !walletAddress || !correctChain || loading;
  const action = !walletAddress ? onConnect : !correctChain ? onSwitchNetwork : undefined;
  const gasFaucetContractAvailable =
    snapshot?.nativeEthFaucetAvailable ?? hasNativeEthFaucetConfiguration;
  const gasFaucetAvailable =
    gasFaucetContractAvailable && hasGaslessNativeFaucetConfiguration;
  const gasFaucetExhausted =
    snapshot !== null && snapshot.nativeEthRemainingClaims === 0n;
  const gasClaimAmount = snapshot?.formatted.nativeEthClaimAmount || "0.05";
  const gasFaucetDetail = !gasFaucetContractAvailable
    ? "deployment pending"
      : !hasGaslessNativeFaucetConfiguration
      ? "gasless relay pending"
      : snapshot
        ? `${snapshot.nativeEthRemainingClaims.toString()} claims left`
        : walletAddress && correctChain
          ? "reading capacity"
          : "connect to read capacity";

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

      <AssetRow
        amount={gasClaimAmount}
        balance={snapshot?.formatted.nativeBalance || "0"}
        claimed={snapshot?.nativeEthClaimed || false}
        claimLabel="Sign to claim 0.05 gas ETH"
        detail={gasFaucetDetail}
        disabled={blocked}
        exhausted={gasFaucetExhausted}
        name="Unichain gas"
        onClaim={onClaimGasEth}
        pending={pendingToken === "nativeEth"}
        pendingLabel="Signing / relaying…"
        symbol="ETH"
        unavailable={!gasFaucetAvailable}
      />

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
          {!walletAddress ? "Connect wallet to claim" : "Switch to Unichain Sepolia"}
        </button>
      ) : (
        <div className="demo-gas-row">
          <span>
            {gasFaucetAvailable
              ? "Signature only · the relay pays claim gas"
              : `Gas: ${snapshot ? readableBalance(snapshot.formatted.nativeBalance, 5) : "—"} ETH`}
          </span>
          {!gasFaucetAvailable && (
            <a
              href="https://developers.uniswap.org/docs/unichain/tools/faucets"
              target="_blank"
              rel="noreferrer"
            >
              Fallback faucet <ArrowUpRight size={10} />
            </a>
          )}
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
          {transactionAsset === "nativeEth" ? "Gas ETH funded" : "Demo assets funded"}
          {" · view transaction "}<ArrowUpRight size={10} />
        </a>
      )}
    </section>
  );
}
