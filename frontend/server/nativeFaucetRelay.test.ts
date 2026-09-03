import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  NativeFaucetRelayError,
  nativeFaucetClaimMessage,
  validateNativeFaucetRequest,
} from "./nativeFaucetRelay";

// Public, deterministic test key only. It must never be used for deployment.
const testAccount = privateKeyToAccount(
  "0x0000000000000000000000000000000000000000000000000000000000000001",
);

describe("native faucet relay authorization", () => {
  it("accepts a gasless signature from the recipient wallet", async () => {
    const message = nativeFaucetClaimMessage(testAccount.address);
    const signature = await testAccount.signMessage({ message });

    await expect(validateNativeFaucetRequest({
      recipient: testAccount.address.toLowerCase(),
      signature,
    })).resolves.toEqual({
      recipient: getAddress(testAccount.address),
      signature,
    });
  });

  it("binds the signature to chain, recipient, and fixed claim amount", () => {
    expect(nativeFaucetClaimMessage(testAccount.address)).toBe(
      [
        "TruePerp native gas faucet",
        "Chain ID: 1301",
        `Recipient: ${getAddress(testAccount.address)}`,
        "Amount: 0.05 ETH",
      ].join("\n"),
    );
  });

  it("rejects a signature submitted for another recipient", async () => {
    const otherRecipient = "0x1111111111111111111111111111111111111111";
    const signature = await testAccount.signMessage({
      message: nativeFaucetClaimMessage(testAccount.address),
    });

    await expect(validateNativeFaucetRequest({
      recipient: otherRecipient,
      signature,
    })).rejects.toMatchObject({ status: 401 } satisfies Partial<NativeFaucetRelayError>);
  });

  it("rejects malformed requests before any RPC or signer work", async () => {
    await expect(validateNativeFaucetRequest({ recipient: "not-an-address" }))
      .rejects.toMatchObject({ status: 400 } satisfies Partial<NativeFaucetRelayError>);
  });
});
