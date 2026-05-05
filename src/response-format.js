import { createCallId, createMessageId, createResponseId } from "./ids.js";

export function createTextResponse({ model, text, usage, id = createResponseId() }) {
  const message = createMessageItem(text);

  return {
    id,
    object: "response",
    created_at: unixTime(),
    status: "completed",
    model,
    output: [message],
    output_text: text,
    usage: mapUsage(usage)
  };
}

export function createToolResponse({ model, toolCalls, usage, text = "", id = createResponseId(), mapToolCall }) {
  const output = [];

  if (text) {
    output.push(createMessageItem(text));
  }

  output.push(...toolCalls.map((toolCall) => {
    if (mapToolCall) {
      return mapToolCall(toolCall);
    }

    const callId = toolCall.id || createCallId();

    return {
      id: callId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? "{}"
    };
  }));

  return {
    id,
    object: "response",
    created_at: unixTime(),
    status: "completed",
    model,
    output,
    output_text: text,
    usage: mapUsage(usage)
  };
}

export function createFailedResponseEvent(message, status = 500, code = "proxy_error", id = createResponseId()) {
  return {
    type: "response.failed",
    response: {
      id,
      object: "response",
      created_at: unixTime(),
      status: "failed",
      error: {
        code,
        message
      },
      usage: null
    }
  };
}

export function createErrorResponse(message, status = 500, code = "proxy_error") {
  return {
    error: {
      message,
      type: "invalid_request_error",
      code,
      status
    }
  };
}

function createMessageItem(text) {
  return {
    id: createMessageId(),
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: []
      }
    ]
  };
}

function mapUsage(usage) {
  if (!usage) {
    return null;
  }

  return {
    input_tokens: usage.prompt_tokens ?? 0,
    input_tokens_details: usage.prompt_tokens_details
      ? { cached_tokens: usage.prompt_tokens_details.cached_tokens ?? 0 }
      : null,
    output_tokens: usage.completion_tokens ?? 0,
    output_tokens_details: usage.completion_tokens_details
      ? { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens ?? 0 }
      : null,
    total_tokens: usage.total_tokens ?? 0
  };
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}
