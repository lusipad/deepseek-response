import { createResponseId } from "./ids.js";
import { chatToolCallToResponseItem } from "./convert.js";

export async function bridgeChatStreamToResponse({ chatStream, responseStream, model, toolMap = new Map() }) {
  const responseId = createResponseId();
  const messageId = `msg_${responseId.slice(5)}`;
  const decoder = new TextDecoder();
  let buffer = "";
  let messageStarted = false;
  let contentStarted = false;
  let outputText = "";
  let nextOutputIndex = 0;
  const outputItems = [];
  const toolCalls = new Map();
  let reasoningContent = "";

  writeSse(responseStream, "response.created", {
    type: "response.created",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model,
      output: []
    }
  });

  writeSse(responseStream, "response.in_progress", {
    type: "response.in_progress",
    response: {
      id: responseId,
      status: "in_progress"
    }
  });

  for await (const chunk of chatStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta ?? {};
      if (typeof delta.reasoning_content === "string") {
        reasoningContent += delta.reasoning_content;
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!messageStarted) {
          messageStarted = true;
          writeSse(responseStream, "response.output_item.added", {
            type: "response.output_item.added",
            response_id: responseId,
            output_index: nextOutputIndex,
            item: {
              id: messageId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: []
            }
          });
          nextOutputIndex += 1;
        }

        if (!contentStarted) {
          contentStarted = true;
          writeSse(responseStream, "response.content_part.added", {
            type: "response.content_part.added",
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
              annotations: []
            }
          });
        }

        outputText += delta.content;
        writeSse(responseStream, "response.output_text.delta", {
          type: "response.output_text.delta",
          response_id: responseId,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: delta.content
        });
      }

      emitToolCallDeltas(responseStream, responseId, delta.tool_calls, toolCalls, toolMap, () => nextOutputIndex++);
    }
  }

  if (contentStarted) {
    writeSse(responseStream, "response.output_text.done", {
      type: "response.output_text.done",
      response_id: responseId,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: outputText
    });

    writeSse(responseStream, "response.content_part.done", {
      type: "response.content_part.done",
      response_id: responseId,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: outputText,
        annotations: []
      }
    });
  }

  if (messageStarted) {
    writeSse(responseStream, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: []
          }
        ]
      }
    });
    outputItems.push({
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: outputText,
          annotations: []
        }
      ]
    });
  }

  for (const toolCall of [...toolCalls.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
    const item = streamToolCallToResponseItem(toolCall, toolMap);

    writeSse(responseStream, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: responseId,
      item_id: toolCall.id,
      output_index: toolCall.outputIndex,
      arguments: toolCall.arguments
    });

    writeSse(responseStream, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: responseId,
      output_index: toolCall.outputIndex,
      item
    });
    outputItems.push(item);
  }

  writeSse(responseStream, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model,
      output: outputItems,
      output_text: outputText
    }
  });
  responseStream.write("data: [DONE]\n\n");

  const response = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: outputItems,
    output_text: outputText,
    usage: null
  };

  const assistantMessage = outputText
    ? { role: "assistant", content: outputText }
    : toolCallsToAssistantMessage(toolCalls);

  if (assistantMessage && reasoningContent) {
    assistantMessage.reasoning_content = reasoningContent;
  }

  return { response, assistantMessage };
}

export function writeSse(stream, event, payload) {
  stream.write(`event: ${event}\n`);
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitToolCallDeltas(stream, responseId, toolCallDeltas, toolCalls, toolMap, allocateOutputIndex) {
  if (!Array.isArray(toolCallDeltas) || toolCallDeltas.length === 0) {
    return;
  }

  for (const toolCall of toolCallDeltas) {
    const index = toolCall.index ?? 0;
    let state = toolCalls.get(index);
    if (!state) {
      const id = toolCall.id ?? `call_${responseId.slice(5)}_${index}`;
      state = {
        id,
        name: toolCall.function?.name ?? "",
        arguments: "",
        outputIndex: allocateOutputIndex(),
        toolMap
      };
      toolCalls.set(index, state);

      writeSse(stream, "response.output_item.added", {
        type: "response.output_item.added",
        response_id: responseId,
        output_index: state.outputIndex,
        item: streamToolCallToResponseItem(state, toolMap, "in_progress")
      });
    }

    if (toolCall.id) {
      state.id = toolCall.id;
    }

    if (toolCall.function?.name) {
      state.name = toolCall.function.name;
    }

    const argumentsDelta = toolCall.function?.arguments ?? "";
    state.arguments += argumentsDelta;

    if (!argumentsDelta) {
      continue;
    }

    writeSse(stream, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: responseId,
      item_id: state.id,
      output_index: state.outputIndex,
      delta: argumentsDelta
    });
  }
}

function streamToolCallToResponseItem(toolCall, toolMap, status = "completed") {
  return {
    ...chatToolCallToResponseItem({
      id: toolCall.id,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments
      }
    }, toolMap),
    status
  };
}

function toolCallsToAssistantMessage(toolCalls) {
  if (toolCalls.size === 0) {
    return null;
  }

  return {
    role: "assistant",
    content: "",
    tool_calls: [...toolCalls.values()]
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments
        }
      }))
  };
}
