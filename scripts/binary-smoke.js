import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const binaryName = process.platform === "win32" ? "deepseek2response.exe" : "deepseek2response";
const binaryPath = join(dist, binaryName);

if (!existsSync(binaryPath)) {
  throw new Error(`dist/${binaryName} not found. Run npm run build:exe first.`);
}

console.log(`binary smoke using ${binaryPath} on ${process.platform}/${process.arch}`);

const mockPort = await getFreePort();
let proxyPort = await getFreePort();
while (proxyPort === mockPort) {
  proxyPort = await getFreePort();
}

const mockServer = createMockDeepSeekServer();
await new Promise((resolveListen) => mockServer.listen(mockPort, "127.0.0.1", resolveListen));

const envPath = join(dist, ".env");
writeFileSync(
  envPath,
  [
    "DEEPSEEK_API_KEY=mock",
    `DEEPSEEK_BASE_URL=http://127.0.0.1:${mockPort}`,
    "DEEPSEEK_MODEL=deepseek-auto",
    "DEEPSEEK_ROUTER_FAST_MODEL=deepseek-v4-flash",
    "DEEPSEEK_ROUTER_PRO_MODEL=deepseek-v4-pro",
    "DEEPSEEK_ROUTER_DEFAULT=pro",
    "DEEPSEEK_ROUTER_SIMPLE_NO_TOOL=fast",
    "DEEPSEEK_ROUTER_FALLBACK=enabled",
    `DEEPSEEK2RESPONSE_PORT=${proxyPort}`,
    "DEEPSEEK2RESPONSE_HOST=127.0.0.1",
    "DEEPSEEK2RESPONSE_API_KEY=local"
  ].join("\n")
);

const child = spawn(binaryPath, {
  cwd: dist,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
let childExit = null;
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("exit", (code, signal) => {
  childExit = { code, signal };
});

try {
  await waitForHttp(`http://127.0.0.1:${proxyPort}/health`);

  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-auto",
      input: "Only reply OK",
      stream: false
    })
  });
  const body = await response.json();

  if (!response.ok || body.status !== "completed" || body.output_text !== "OK" || body.model !== "deepseek-v4-flash") {
    throw new Error(`Unexpected binary smoke response: ${JSON.stringify(body)}`);
  }

  console.log(`binary smoke passed on ${process.platform}/${process.arch}`);
} catch (error) {
  console.error("binary stdout:");
  console.error(stdout);
  console.error("binary stderr:");
  console.error(stderr);
  console.error(`binary exit: ${JSON.stringify(childExit)}`);
  throw error;
} finally {
  if (childExit === null) {
    child.kill();
  }
  mockServer.close();
  rmSync(envPath, { force: true });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 300));
  }

  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

function createMockDeepSeekServer() {
  return createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/chat/completions") {
      const body = await readJson(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_mock",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "OK",
              reasoning_content: "mock reasoning"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}
