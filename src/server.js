import http from "node:http";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadDotEnv } from "./env.js";
import { DeepSeekClient, DeepSeekError } from "./deepseek-client.js";
import { applyAssistantMemories, assistantMessageFromChat, chatToResponse, responsesToChat } from "./convert.js";
import { createErrorResponse, createFailedResponseEvent } from "./response-format.js";
import { isRetryableUpstreamError, selectDeepSeekModel } from "./router.js";
import { getAssistantMemories, getResponse, saveAssistantMemory, saveResponse } from "./store.js";
import { bridgeChatStreamToResponse } from "./sse.js";

const DEFAULT_PORT = 18488;
const DEFAULT_HOST = "127.0.0.1";

process.removeAllListeners("warning");
process.on("warning", () => {});

export function createServer({
  apiKey = process.env.DEEPSEEK_API_KEY,
  baseUrl = process.env.DEEPSEEK_BASE_URL,
  defaultModel = process.env.DEEPSEEK_MODEL,
  client,
  onChatPayload
} = {}) {
  const deepSeekClient = client ?? (apiKey ? new DeepSeekClient({ apiKey, baseUrl }) : null);

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && request.url?.startsWith("/v1/responses/")) {
        const id = request.url.split("/").pop();
        const stored = getResponse(id);
        sendJson(response, stored ? 200 : 404, stored ?? createErrorResponse("Response not found.", 404, "not_found"));
        return;
      }

      if (request.method === "POST" && request.url === "/v1/responses") {
        if (!deepSeekClient) {
          sendJson(response, 500, createErrorResponse("DEEPSEEK_API_KEY is required."));
          return;
        }

        const body = await readJson(request);
        const requestedModel = body.model || defaultModel;
        const conversationKey = body.prompt_cache_key || request.headers.session_id;
        const convertedRequest = responsesToChat({ ...body, model: requestedModel });
        const chatPayload = {
          ...convertedRequest.chatRequest,
          model: requestedModel
        };
        chatPayload.messages = applyAssistantMemories(chatPayload.messages, getAssistantMemories(conversationKey));
        const routing = selectDeepSeekModel({ requestedModel, responsesRequest: body, chatPayload });
        chatPayload.model = routing.model;
        onChatPayload?.(chatPayload, { conversationKey, stream: Boolean(body.stream), routing });
        await writeDebugLog({
          conversationKey,
          stream: Boolean(body.stream),
          routing,
          responsesInputItemTypes: Array.isArray(body.input) ? body.input.map((item) => item?.type ?? item?.role ?? typeof item) : typeof body.input,
          chatPayload
        });

        if (body.stream) {
          const streamResult = await callDeepSeekWithFallback({
            primaryModel: routing.model,
            fallbackModel: routing.fallbackModel,
            fallbackEnabled: routing.fallbackEnabled,
            execute: (payload) => deepSeekClient.streamChatCompletion(payload),
            payload: chatPayload
          });
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive"
          });
          const streamed = await bridgeChatStreamToResponse({
            chatStream: streamResult.result,
            responseStream: response,
            model: streamResult.model,
            toolMap: convertedRequest.toolMap
          });
          saveResponse(streamed.response);
          saveAssistantMemory(conversationKey, streamed.assistantMessage);
          response.end();
          return;
        }

        const completionResult = await callDeepSeekWithFallback({
          primaryModel: routing.model,
          fallbackModel: routing.fallbackModel,
          fallbackEnabled: routing.fallbackEnabled,
          execute: (payload) => deepSeekClient.createChatCompletion(payload),
          payload: { ...chatPayload, stream: false }
        });
        const chatCompletion = completionResult.result;
        const converted = chatToResponse(chatCompletion, completionResult.model, convertedRequest.toolMap);
        saveResponse(converted);
        saveAssistantMemory(conversationKey, assistantMessageFromChat(chatCompletion));
        sendJson(response, 200, converted);
        return;
      }

      sendJson(response, 404, createErrorResponse("Route not found.", 404, "not_found"));
    } catch (error) {
      const status = error instanceof DeepSeekError ? error.status : 500;
      if (response.headersSent) {
        console.error(error);
        response.write(`event: response.failed\n`);
        response.write(`data: ${JSON.stringify(createFailedResponseEvent(error.message, status))}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }

      sendJson(response, status, createErrorResponse(error.message, status));
    }
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function writeDebugLog(entry) {
  const logPath = process.env.DEEPSEEK2RESPONSE_DEBUG_LOG;
  if (!logPath) {
    return;
  }

  await appendFile(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}

async function callDeepSeekWithFallback({ primaryModel, fallbackModel, fallbackEnabled, execute, payload }) {
  try {
    return {
      model: primaryModel,
      result: await execute({ ...payload, model: primaryModel })
    };
  } catch (error) {
    if (!fallbackEnabled || !fallbackModel || !isRetryableUpstreamError(error)) {
      throw error;
    }

    return {
      model: fallbackModel,
      result: await execute({ ...payload, model: fallbackModel })
    };
  }
}

export function startStandalone() {
  loadDotEnv(resolveEnvPath());
  const port = Number(process.env.DEEPSEEK2RESPONSE_PORT || DEFAULT_PORT);
  const host = process.env.DEEPSEEK2RESPONSE_HOST || DEFAULT_HOST;

  createServer().listen(port, host, () => {
    console.log(`deepseek2response listening on http://${host}:${port}`);
  });
}

export function resolveEnvPath(execPath = process.execPath, env = process.env) {
  if (env.DEEPSEEK2RESPONSE_ENV_FILE) {
    return env.DEEPSEEK2RESPONSE_ENV_FILE;
  }

  if (execPath.toLowerCase().endsWith("deepseek2response.exe")) {
    const exeEnvPath = join(dirname(execPath), ".env");
    if (existsSync(exeEnvPath)) {
      return exeEnvPath;
    }

    return join(dirname(execPath), "..", ".env");
  }

  return ".env";
}

const isDirectRun = typeof __DEEPSEEK2RESPONSE_BUNDLE__ === "undefined" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startStandalone();
}
