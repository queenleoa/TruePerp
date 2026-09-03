import {
  relayErrorResponse,
  relayNativeFaucetClaim,
} from "../../server/nativeFaucetRelay.ts";

export default async function handler(request: Request): Promise<Response> {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST to request native gas ETH." }), {
      status: 405,
      headers: { ...headers, allow: "POST" },
    });
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4_096) {
    return new Response(JSON.stringify({ error: "Faucet request is too large." }), {
      status: 413,
      headers,
    });
  }

  const allowedOrigin = process.env.FAUCET_ALLOWED_ORIGIN?.trim();
  const requestOrigin = request.headers.get("origin");
  if (allowedOrigin && requestOrigin && requestOrigin !== allowedOrigin) {
    return new Response(
      JSON.stringify({ error: "This origin is not permitted to use the faucet relay." }),
      { status: 403, headers },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Faucet request body must be valid JSON." }), {
      status: 400,
      headers,
    });
  }

  try {
    const result = await relayNativeFaucetClaim(payload, process.env);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (caught) {
    const failure = relayErrorResponse(caught);
    return new Response(JSON.stringify({ error: failure.error }), {
      status: failure.status,
      headers,
    });
  }
}
