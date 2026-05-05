import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { clearStore } from "../src/store.js";
import { DeepSeekError } from "../src/deepseek-client.js";
import { createServer } from "../src/server.js";

test("serves non-streaming Responses requests through a DeepSeek-like client", async (t) => {
  clearStore();

  let capturedPayload;
  const server = createServer({
    apiKey: "test",
    client: {
      async createChatCompletion(payload) {
        capturedPayload = payload;
        return {
          model: payload.model,
          choices: [{ message: { role: "assistant", content: "OK" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      input: "hello",
      stream: false
    })
  });

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.output_text, "OK");
  assert.equal(capturedPayload.messages[0].content, "hello");
});

test("translates Codex namespace tools to Chat and restores Responses function namespace", async (t) => {
  clearStore();

  let capturedPayload;
  const server = createServer({
    apiKey: "test",
    client: {
      async createChatCompletion(payload) {
        capturedPayload = payload;
        return {
          model: payload.model,
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_mcp",
                    type: "function",
                    function: {
                      name: "mcp__demo__lookup",
                      arguments: "{\"id\":\"1\"}"
                    }
                  }
                ]
              }
            }
          ]
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const payload = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-pro",
      input: "lookup",
      tools: [
        {
          type: "namespace",
          name: "mcp__demo__",
          description: "Demo",
          tools: [
            {
              type: "function",
              name: "lookup",
              description: "Lookup",
              parameters: { type: "object", properties: { id: { type: "string" } } }
            }
          ]
        }
      ]
    })
  }).then((response) => response.json());

  assert.equal(capturedPayload.tools[0].function.name, "mcp__demo__lookup");
  assert.equal(payload.output[0].type, "function_call");
  assert.equal(payload.output[0].namespace, "mcp__demo__");
  assert.equal(payload.output[0].name, "lookup");
});

test("retrieves a stored response by id", async (t) => {
  clearStore();

  const server = createServer({
    apiKey: "test",
    client: {
      async createChatCompletion(payload) {
        return {
          model: payload.model,
          choices: [{ message: { role: "assistant", content: "stored" } }]
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const created = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" })
  }).then((response) => response.json());

  const retrieved = await fetch(`${baseUrl}/v1/responses/${created.id}`).then((response) => response.json());
  assert.equal(retrieved.id, created.id);
  assert.equal(retrieved.output_text, "stored");
});

test("returns a clear error when no DeepSeek API key is configured", async (t) => {
  const server = createServer({ apiKey: "" });
  const { baseUrl, close } = await listen(server);
  t.after(close);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-pro", input: "hello" })
  });

  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.equal(payload.error.message, "DEEPSEEK_API_KEY is required.");
});

test("adds stored reasoning_content to matching assistant messages without duplicating history", async (t) => {
  clearStore();

  const capturedPayloads = [];
  const server = createServer({
    apiKey: "test",
    onChatPayload(payload) {
      capturedPayloads.push(payload);
    },
    client: {
      async createChatCompletion(payload) {
        return {
          model: payload.model,
          choices: [
            {
              message: {
                role: "assistant",
                content: "OK",
                reasoning_content: "reasoning to carry"
              }
            }
          ]
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  for (const input of ["first", "second"]) {
    await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        input: input === "first"
          ? input
          : [
              { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
              { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] }
            ],
        stream: false,
        prompt_cache_key: "same-conversation"
      })
    });
  }

  assert.equal(capturedPayloads.length, 2);
  assert.equal(capturedPayloads[1].messages.length, 3);
  assert.equal(capturedPayloads[1].messages[1].role, "assistant");
  assert.equal(capturedPayloads[1].messages[1].reasoning_content, "reasoning to carry");
});

test("routes deepseek-auto requests through the local router", async (t) => {
  clearStore();

  let capturedPayload;
  let capturedRouting;
  const server = createServer({
    apiKey: "test",
    onChatPayload(payload, meta) {
      capturedPayload = payload;
      capturedRouting = meta.routing;
    },
    client: {
      async createChatCompletion(payload) {
        return {
          model: payload.model,
          choices: [{ message: { role: "assistant", content: "OK" } }]
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const payload = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-auto", input: "hello" })
  }).then((response) => response.json());

  assert.equal(capturedPayload.model, "deepseek-v4-flash");
  assert.equal(capturedRouting.reason, "simple_user_turn");
  assert.equal(payload.model, "deepseek-v4-flash");
});

test("falls back to the alternate model for retryable non-streaming DeepSeek errors", async (t) => {
  clearStore();

  const attemptedModels = [];
  const server = createServer({
    apiKey: "test",
    client: {
      async createChatCompletion(payload) {
        attemptedModels.push(payload.model);
        if (attemptedModels.length === 1) {
          throw new DeepSeekError("rate limited", 429);
        }

        return {
          model: payload.model,
          choices: [{ message: { role: "assistant", content: "OK" } }]
        };
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const payload = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-auto", input: "hello" })
  }).then((response) => response.json());

  assert.deepEqual(attemptedModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(payload.model, "deepseek-v4-pro");
  assert.equal(payload.output_text, "OK");
});

test("falls back before opening a streaming Responses connection", async (t) => {
  clearStore();

  const attemptedModels = [];
  const server = createServer({
    apiKey: "test",
    client: {
      async streamChatCompletion(payload) {
        attemptedModels.push(payload.model);
        if (attemptedModels.length === 1) {
          throw new DeepSeekError("temporary unavailable", 503);
        }

        return Readable.from([
          Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\n`),
          Buffer.from("data: [DONE]\n\n")
        ]);
      }
    }
  });

  const { baseUrl, close } = await listen(server);
  t.after(close);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-auto", input: "hello", stream: true })
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.deepEqual(attemptedModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.match(text, /"model":"deepseek-v4-pro"/);
  assert.match(text, /"output_text":"OK"/);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}
