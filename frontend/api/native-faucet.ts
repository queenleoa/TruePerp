import {
  relayErrorResponse,
  relayNativeFaucetClaim,
} from "../server/nativeFaucetRelay";

interface ApiRequest {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Use POST to request native gas ETH." });
    return;
  }

  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > 4_096) {
    response.status(413).json({ error: "Faucet request is too large." });
    return;
  }

  const allowedOrigin = process.env.FAUCET_ALLOWED_ORIGIN?.trim();
  const requestOrigin = request.headers.origin;
  if (
    allowedOrigin &&
    typeof requestOrigin === "string" &&
    requestOrigin !== allowedOrigin
  ) {
    response.status(403).json({ error: "This origin is not permitted to use the faucet relay." });
    return;
  }

  let payload: unknown;
  try {
    payload = typeof request.body === "string"
      ? JSON.parse(request.body) as unknown
      : request.body;
  } catch {
    response.status(400).json({ error: "Faucet request body must be valid JSON." });
    return;
  }

  try {
    const result = await relayNativeFaucetClaim(payload, process.env);
    response.status(200).json(result);
  } catch (caught) {
    const failure = relayErrorResponse(caught);
    response.status(failure.status).json({ error: failure.error });
  }
}
