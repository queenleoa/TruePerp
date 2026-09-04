import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const UNICHAIN_SEPOLIA_CHAIN_ID = 1301;
const DEFAULT_RPC_URL = "https://sepolia.unichain.org";
const DEFAULT_FAUCET_ADDRESS = "0xf886d5EDF23946103cE5dE1b0F63E242dBFcd0fa";

const unichainSepolia = defineChain({
  id: UNICHAIN_SEPOLIA_CHAIN_ID,
  name: "Unichain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC_URL] } },
  blockExplorers: {
    default: { name: "Uniscan", url: "https://sepolia.uniscan.xyz" },
  },
  testnet: true,
});

const nativeGasFaucetAbi = [
  {
    type: "function",
    name: "relayer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    type: "function",
    name: "hasClaimed",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "claimed", type: "bool" }],
  },
  {
    type: "function",
    name: "remainingClaims",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      { name: "available", type: "uint256" },
      { name: "required", type: "uint256" },
    ],
  },
  { type: "error", name: "NativeTransferFailed", inputs: [] },
] as const;

export interface NativeFaucetRelayEnvironment {
  FAUCET_RELAYER_PRIVATE_KEY?: string;
  WALLET_PRIVATE_KEY?: string;
  NATIVE_ETH_FAUCET_ADDRESS?: string;
  VITE_NATIVE_ETH_FAUCET?: string;
  UNICHAIN_RPC_URL?: string;
  VITE_RPC_URL?: string;
}

export interface NativeFaucetRequest {
  recipient: Address;
  signature: Hex;
}

export interface NativeFaucetRelayResult {
  hash: Hash;
  recipient: Address;
  amount: "0.05";
}

export class NativeFaucetRelayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "NativeFaucetRelayError";
    this.status = status;
  }
}

export function nativeFaucetClaimMessage(recipient: Address): string {
  return [
    "TruePerp native gas faucet",
    `Chain ID: ${UNICHAIN_SEPOLIA_CHAIN_ID}`,
    `Recipient: ${getAddress(recipient)}`,
    "Amount: 0.05 ETH",
  ].join("\n");
}

export async function validateNativeFaucetRequest(
  payload: unknown,
): Promise<NativeFaucetRequest> {
  if (!payload || typeof payload !== "object") {
    throw new NativeFaucetRelayError(400, "A recipient and wallet signature are required.");
  }

  const { recipient: rawRecipient, signature: rawSignature } = payload as {
    recipient?: unknown;
    signature?: unknown;
  };
  if (typeof rawRecipient !== "string" || !isAddress(rawRecipient, { strict: false })) {
    throw new NativeFaucetRelayError(400, "Recipient must be a valid EVM address.");
  }
  if (
    typeof rawSignature !== "string" ||
    !/^0x(?:[0-9a-f]{128}|[0-9a-f]{130})$/i.test(rawSignature)
  ) {
    throw new NativeFaucetRelayError(400, "A valid wallet signature is required.");
  }

  const recipient = getAddress(rawRecipient);
  const signature = rawSignature as Hex;
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: nativeFaucetClaimMessage(recipient),
      signature,
    });
  } catch {
    throw new NativeFaucetRelayError(401, "The wallet signature could not be verified.");
  }
  if (getAddress(signer) !== recipient) {
    throw new NativeFaucetRelayError(401, "The signature does not belong to the recipient wallet.");
  }

  return { recipient, signature };
}

function relayConfiguration(environment: NativeFaucetRelayEnvironment) {
  const privateKey = (
    environment.FAUCET_RELAYER_PRIVATE_KEY || environment.WALLET_PRIVATE_KEY || ""
  ).trim();
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
    throw new NativeFaucetRelayError(503, "The faucet relay signer is not configured.");
  }

  const faucetValue = (
    environment.NATIVE_ETH_FAUCET_ADDRESS ||
    environment.VITE_NATIVE_ETH_FAUCET ||
    DEFAULT_FAUCET_ADDRESS
  ).trim();
  if (!isAddress(faucetValue, { strict: false })) {
    throw new NativeFaucetRelayError(503, "The native ETH faucet contract is not configured.");
  }

  const rpcUrl = (
    environment.UNICHAIN_RPC_URL || environment.VITE_RPC_URL || DEFAULT_RPC_URL
  ).trim();
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new NativeFaucetRelayError(503, "The Unichain Sepolia RPC is not configured.");
  }

  return {
    privateKey: privateKey as Hex,
    faucet: getAddress(faucetValue),
    rpcUrl,
  };
}

function revertedErrorName(caught: unknown): string | undefined {
  if (!(caught instanceof BaseError)) return undefined;
  const reverted = caught.walk(
    (error) => error instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null;
  return reverted?.data?.errorName;
}

function safeRelayError(caught: unknown): NativeFaucetRelayError {
  if (caught instanceof NativeFaucetRelayError) return caught;
  const errorName = revertedErrorName(caught);
  if (errorName === "AlreadyClaimed") {
    return new NativeFaucetRelayError(409, "This wallet has already claimed gas ETH.");
  }
  if (errorName === "InsufficientBalance") {
    return new NativeFaucetRelayError(503, "The native ETH faucet is empty.");
  }
  if (errorName === "Unauthorized") {
    return new NativeFaucetRelayError(503, "The configured server wallet is not the faucet relayer.");
  }
  if (errorName === "NativeTransferFailed") {
    return new NativeFaucetRelayError(422, "The recipient wallet rejected the native ETH transfer.");
  }
  const detail =
    caught instanceof BaseError
      ? caught.shortMessage
      : caught instanceof Error
        ? caught.message
        : "";
  return new NativeFaucetRelayError(
    502,
    detail
      ? `The Unichain Sepolia relay transaction failed (${detail.slice(0, 160)}). Please try again.`
      : "The Unichain Sepolia relay transaction failed. Please try again.",
  );
}

/** Config and validation errors, and known faucet reverts, are final; anything
 * else (RPC flake, rate limit, nonce race) is worth one retry. */
function isRetryableFailure(caught: unknown): boolean {
  return !(caught instanceof NativeFaucetRelayError) && revertedErrorName(caught) === undefined;
}

let relayQueue: Promise<void> = Promise.resolve();

async function submitNativeFaucetClaim(
  payload: unknown,
  environment: NativeFaucetRelayEnvironment,
): Promise<NativeFaucetRelayResult> {
  const { recipient } = await validateNativeFaucetRequest(payload);
  const { privateKey, faucet, rpcUrl } = relayConfiguration(environment);
  const account = privateKeyToAccount(privateKey);
  // Fail fast on a stuck RPC so the retry still fits a serverless budget.
  const transport = http(rpcUrl, { timeout: 8_000 });
  const publicClient = createPublicClient({ chain: unichainSepolia, transport });
  const walletClient = createWalletClient({ account, chain: unichainSepolia, transport });

  const [chainId, configuredRelayer, alreadyClaimed, remainingClaims] = await Promise.all([
    publicClient.getChainId(),
    publicClient.readContract({
      address: faucet,
      abi: nativeGasFaucetAbi,
      functionName: "relayer",
    }),
    publicClient.readContract({
      address: faucet,
      abi: nativeGasFaucetAbi,
      functionName: "hasClaimed",
      args: [recipient],
    }),
    publicClient.readContract({
      address: faucet,
      abi: nativeGasFaucetAbi,
      functionName: "remainingClaims",
    }),
  ]);

  if (chainId !== UNICHAIN_SEPOLIA_CHAIN_ID) {
    throw new NativeFaucetRelayError(503, "The faucet relay RPC is on the wrong chain.");
  }
  if (getAddress(configuredRelayer) !== account.address) {
    throw new NativeFaucetRelayError(503, "The configured server wallet is not the faucet relayer.");
  }
  if (alreadyClaimed) {
    throw new NativeFaucetRelayError(409, "This wallet has already claimed gas ETH.");
  }
  if (remainingClaims === 0n) {
    throw new NativeFaucetRelayError(503, "The native ETH faucet is empty.");
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: faucet,
    abi: nativeGasFaucetAbi,
    functionName: "claimFor",
    args: [recipient],
  });
  const hash = await walletClient.writeContract(request);
  // Return as soon as the relayer broadcasts. The browser tracks this hash to
  // confirmation, avoiding a serverless timeout after a successful submission.
  return { hash, recipient, amount: "0.05" };
}

/** Serialize writes within a warm server process to reduce relayer nonce races. */
export function relayNativeFaucetClaim(
  payload: unknown,
  environment: NativeFaucetRelayEnvironment,
): Promise<NativeFaucetRelayResult> {
  const attempt = async () => {
    try {
      return await submitNativeFaucetClaim(payload, environment);
    } catch (caught) {
      if (!isRetryableFailure(caught)) throw caught;
      // Transient RPC or nonce failure: re-run the full submit once. The
      // pre-checks re-read chain state, so a first attempt that actually
      // landed resolves to AlreadyClaimed instead of double-paying.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return submitNativeFaucetClaim(payload, environment);
    }
  };
  const pending = relayQueue.then(attempt, attempt);
  relayQueue = pending.then(() => undefined, () => undefined);
  return pending.catch((caught) => {
    throw safeRelayError(caught);
  });
}

export function relayErrorResponse(caught: unknown): { status: number; error: string } {
  const safe = safeRelayError(caught);
  return { status: safe.status, error: safe.message };
}
