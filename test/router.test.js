import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableUpstreamError, selectDeepSeekModel } from "../src/router.js";

const ENV = {
  DEEPSEEK_ROUTER_FAST_MODEL: "deepseek-v4-flash",
  DEEPSEEK_ROUTER_PRO_MODEL: "deepseek-v4-pro",
  DEEPSEEK_ROUTER_DEFAULT: "pro",
  DEEPSEEK_ROUTER_SIMPLE_NO_TOOL: "fast",
  DEEPSEEK_ROUTER_FALLBACK: "enabled"
};

test("routes deepseek-auto simple user-only requests to fast", () => {
  const routing = selectDeepSeekModel({
    requestedModel: "deepseek-auto",
    responsesRequest: {
      input: "hello"
    },
    chatPayload: {
      messages: [{ role: "user", content: "hello" }]
    },
    env: ENV
  });

  assert.equal(routing.model, "deepseek-v4-flash");
  assert.equal(routing.fallbackModel, "deepseek-v4-pro");
  assert.equal(routing.reason, "simple_user_turn");
});

test("routes high reasoning deepseek-auto requests to pro", () => {
  const routing = selectDeepSeekModel({
    requestedModel: "deepseek-auto",
    responsesRequest: {
      input: "hard",
      reasoning: { effort: "high" }
    },
    chatPayload: {
      messages: [{ role: "user", content: "hard" }]
    },
    env: ENV
  });

  assert.equal(routing.model, "deepseek-v4-pro");
  assert.equal(routing.fallbackModel, "deepseek-v4-flash");
  assert.equal(routing.reason, "high_reasoning");
});

test("routes tool replay loops to pro", () => {
  const routing = selectDeepSeekModel({
    requestedModel: "deepseek-auto",
    responsesRequest: {
      input: [
        { type: "function_call_output", call_id: "call_1", output: "OK" }
      ]
    },
    chatPayload: {
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "OK" }
      ]
    },
    env: ENV
  });

  assert.equal(routing.model, "deepseek-v4-pro");
  assert.equal(routing.reason, "tool_loop");
});

test("keeps explicit non-auto model unchanged", () => {
  const routing = selectDeepSeekModel({
    requestedModel: "deepseek-v4-pro",
    responsesRequest: { input: "hello" },
    chatPayload: {
      messages: [{ role: "user", content: "hello" }]
    },
    env: ENV
  });

  assert.equal(routing.model, "deepseek-v4-pro");
  assert.equal(routing.routed, false);
  assert.equal(routing.fallbackEnabled, false);
});

test("identifies retryable upstream failures for fallback", () => {
  assert.equal(isRetryableUpstreamError({ status: 429 }), true);
  assert.equal(isRetryableUpstreamError({ status: 503 }), true);
  assert.equal(isRetryableUpstreamError({ status: 400 }), false);
});
