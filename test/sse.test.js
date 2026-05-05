import assert from "node:assert/strict";
import test from "node:test";
import { Readable, Writable } from "node:stream";
import { bridgeChatStreamToResponse } from "../src/sse.js";

test("bridges chat text stream into ordered Responses SSE events", async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "O" } }]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "K" } }]
    })}\n\n`,
    "data: [DONE]\n\n"
  ].map((chunk) => Buffer.from(chunk));
  let output = "";
  const responseStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  await bridgeChatStreamToResponse({
    chatStream: Readable.from(chunks),
    responseStream,
    model: "deepseek-v4-pro"
  });

  assert.match(output, /event: response\.output_item\.added/);
  assert.match(output, /event: response\.content_part\.added/);
  assert.match(output, /event: response\.output_text\.delta/);
  assert.match(output, /event: response\.output_text\.done/);
  assert.match(output, /event: response\.completed/);
  assert.ok(output.indexOf("response.output_item.added") < output.indexOf("response.output_text.delta"));
  assert.match(output, /"output_text":"OK"/);
});

test("bridges chat tool call stream into Responses function call events", async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "shell",
                  arguments: "{\"command\""
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: ":\"echo OK\"}"
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    "data: [DONE]\n\n"
  ].map((chunk) => Buffer.from(chunk));
  let output = "";
  const responseStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  await bridgeChatStreamToResponse({
    chatStream: Readable.from(chunks),
    responseStream,
    model: "deepseek-v4-pro"
  });

  assert.match(output, /event: response\.output_item\.added/);
  assert.match(output, /event: response\.function_call_arguments\.delta/);
  assert.match(output, /event: response\.function_call_arguments\.done/);
  assert.match(output, /event: response\.output_item\.done/);
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"arguments":"\{\\"command\\":\\"echo OK\\"\}"/);
});

test("bridges chat tool call stream back into Codex custom_tool_call items", async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: "{\"input\":\"*** Begin"
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: " Patch\\n*** End Patch\"}"
                }
              }
            ]
          }
        }
      ]
    })}\n\n`,
    "data: [DONE]\n\n"
  ].map((chunk) => Buffer.from(chunk));
  let output = "";
  const responseStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const toolMap = new Map([
    ["apply_patch", {
      type: "custom",
      chatName: "apply_patch",
      name: "apply_patch"
    }]
  ]);

  const result = await bridgeChatStreamToResponse({
    chatStream: Readable.from(chunks),
    responseStream,
    model: "deepseek-v4-pro",
    toolMap
  });

  assert.match(output, /"type":"custom_tool_call"/);
  assert.match(output, /"input":"\*\*\* Begin Patch\\n\*\*\* End Patch"/);
  assert.equal(result.response.output[0].type, "custom_tool_call");
});

test("preserves streaming reasoning_content for later DeepSeek turns", async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [{ delta: { reasoning_content: "think", content: "OK" } }]
    })}\n\n`,
    "data: [DONE]\n\n"
  ].map((chunk) => Buffer.from(chunk));
  let output = "";
  const responseStream = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  const result = await bridgeChatStreamToResponse({
    chatStream: Readable.from(chunks),
    responseStream,
    model: "deepseek-v4-pro"
  });

  assert.equal(result.assistantMessage.reasoning_content, "think");
  assert.match(output, /"output_text":"OK"/);
});
