import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  relayErrorResponse,
  relayNativeFaucetClaim,
  type NativeFaucetRelayEnvironment,
} from "./server/nativeFaucetRelay.ts";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

function localNativeFaucetRelay(
  environment: NativeFaucetRelayEnvironment,
): Plugin {
  return {
    name: "trueperp-local-native-faucet-relay",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/api/native-faucet") {
          next();
          return;
        }

        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("Allow", "POST");
          response.end(JSON.stringify({ error: "Use POST to request native gas ETH." }));
          return;
        }

        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > 4_096) {
              response.statusCode = 413;
              response.end(JSON.stringify({ error: "Faucet request is too large." }));
              return;
            }
            chunks.push(buffer);
          }
          let payload: unknown;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "Faucet request body must be valid JSON." }));
            return;
          }
          const result = await relayNativeFaucetClaim(payload, environment);
          response.statusCode = 200;
          response.end(JSON.stringify(result));
        } catch (caught) {
          const failure = relayErrorResponse(caught);
          response.statusCode = failure.status;
          response.end(JSON.stringify({ error: failure.error }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = {
    ...loadEnv(mode, workspaceRoot, ""),
    ...loadEnv(mode, frontendRoot, ""),
    ...process.env,
  } as NativeFaucetRelayEnvironment;

  return {
    base: "./",
    plugins: [react(), localNativeFaucetRelay(environment)],
    build: {
      target: "es2022",
      sourcemap: true,
    },
  };
});
