import { createToolResponse, createTextResponse } from "./response-format.js";
import { createCallId } from "./ids.js";

const INPUT_TEXT_TYPES = new Set(["input_text", "output_text"]);
const LOCAL_SHELL_PARAMETERS = {
  type: "object",
  properties: {
    command: {
      type: "array",
      items: { type: "string" }
    },
    timeout_ms: { type: "integer" },
    working_directory: { type: "string" },
    env: {
      type: "object",
      additionalProperties: { type: "string" }
    },
    user: { type: "string" }
  },
  required: ["command"]
};

export function responsesToChat(request, previousMessages = []) {
  const messages = [...previousMessages];
  const toolMap = createToolMap(request.tools);

  if (request.instructions) {
    messages.push({
      role: "system",
      content: request.instructions
    });
  }

  const inputItems = Array.isArray(request.input) ? request.input : [{ role: "user", content: request.input ?? "" }];

  for (const item of inputItems) {
    const converted = convertInputItem(item, toolMap);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else if (converted) {
      messages.push(converted);
    }
  }

  const chatRequest = {
    model: request.model,
    messages: normalizeMessages(messages),
    tools: convertTools(request.tools, toolMap),
    tool_choice: convertToolChoice(request.tool_choice, toolMap),
    stream: Boolean(request.stream)
  };

  const reasoningEffort = convertReasoningEffort(request.reasoning?.effort);
  if (reasoningEffort) {
    chatRequest.reasoning_effort = reasoningEffort;
  }

  const thinking = convertThinking(request.reasoning, process.env.DEEPSEEK_THINKING);
  if (thinking) {
    chatRequest.thinking = thinking;
  }

  const responseFormat = convertResponseFormat(request.text?.format);
  if (responseFormat) {
    chatRequest.response_format = responseFormat;
  }

  return {
    chatRequest,
    toolMap
  };
}

export function chatToResponse(chatCompletion, fallbackModel, toolMap = new Map()) {
  const choice = chatCompletion.choices?.[0];
  const message = choice?.message ?? {};
  const model = chatCompletion.model ?? fallbackModel;
  const text = message.content ?? "";

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return createToolResponse({
      model,
      toolCalls: message.tool_calls,
      usage: chatCompletion.usage,
      text,
      mapToolCall: (toolCall) => chatToolCallToResponseItem(toolCall, toolMap)
    });
  }

  return createTextResponse({
    model,
    text,
    usage: chatCompletion.usage
  });
}

export function assistantMessageFromChat(chatCompletion) {
  const message = chatCompletion.choices?.[0]?.message;
  if (!message) {
    return null;
  }

  const assistant = {
    role: "assistant",
    content: message.content ?? ""
  };

  if (message.reasoning_content) {
    assistant.reasoning_content = message.reasoning_content;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    assistant.tool_calls = message.tool_calls;
  }

  return assistant;
}

export function appendResponseToConversation(messages, chatCompletion) {
  const assistant = assistantMessageFromChat(chatCompletion);
  return assistant ? [...messages, assistant] : messages;
}

export function applyAssistantMemories(messages, memories) {
  if (!Array.isArray(memories) || memories.length === 0) {
    return messages;
  }

  const remaining = [...memories];

  return messages.map((message) => {
    if (message.role !== "assistant" || message.reasoning_content) {
      return message;
    }

    const signature = createAssistantSignature(message);
    const memoryIndex = remaining.findIndex((memory) => memory.signature === signature);
    if (memoryIndex === -1) {
      return message;
    }

    const [memory] = remaining.splice(memoryIndex, 1);
    return {
      ...message,
      reasoning_content: memory.reasoning_content
    };
  });
}

export function createAssistantSignature(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return `tools:${message.tool_calls.map((toolCall) => `${toolCall.id}:${toolCall.function?.name}:${toolCall.function?.arguments}`).join("|")}`;
  }

  return `text:${message.content ?? ""}`;
}

export function chatToolCallToResponseItem(toolCall, toolMap = new Map()) {
  const chatName = toolCall.function?.name ?? "";
  const mapping = toolMap.get(chatName);
  const callId = toolCall.id || createCallId();
  const argumentsText = toolCall.function?.arguments ?? "{}";

  if (mapping?.type === "custom") {
    return {
      id: callId,
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: mapping.name,
      input: extractCustomToolInput(argumentsText)
    };
  }

  if (mapping?.type === "local_shell") {
    return {
      id: callId,
      type: "local_shell_call",
      call_id: callId,
      status: "completed",
      action: {
        type: "exec",
        ...extractLocalShellAction(argumentsText)
      }
    };
  }

  return {
    id: callId,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: mapping?.name ?? chatName,
    ...(mapping?.namespace ? { namespace: mapping.namespace } : {}),
    arguments: argumentsText
  };
}

function convertInputItem(item, toolMap) {
  if (typeof item === "string") {
    return { role: "user", content: item };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: stringifyContent(item.output)
    };
  }

  if (item.type === "tool_search_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: stringifyContent(item.tools ?? [])
    };
  }

  if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "local_shell_call") {
    const toolCall = responseItemToChatToolCall(item, toolMap);
    if (!toolCall) {
      return null;
    }

    return {
      role: "assistant",
      content: null,
      tool_calls: [toolCall]
    };
  }

  if (item.type === "message") {
    return {
      role: mapRole(item.role),
      content: stringifyMessageContent(item.content)
    };
  }

  if (item.role) {
    return {
      role: mapRole(item.role),
      content: stringifyMessageContent(item.content)
    };
  }

  return {
    role: "user",
    content: stringifyContent(item)
  };
}

function responseItemToChatToolCall(item, toolMap) {
  const callId = item.call_id ?? item.id;
  if (!callId) {
    return null;
  }

  if (item.type === "custom_tool_call") {
    const chatName = findChatToolName(toolMap, "custom", item.name) ?? sanitizeToolName(item.name);
    return {
      id: callId,
      type: "function",
      function: {
        name: chatName,
        arguments: JSON.stringify({ input: item.input ?? "" })
      }
    };
  }

  if (item.type === "local_shell_call") {
    const chatName = findChatToolName(toolMap, "local_shell", "local_shell") ?? "local_shell";
    return {
      id: callId,
      type: "function",
      function: {
        name: chatName,
        arguments: JSON.stringify(item.action?.type === "exec" ? {
          command: item.action.command ?? [],
          timeout_ms: item.action.timeout_ms ?? null,
          working_directory: item.action.working_directory ?? null,
          env: item.action.env ?? null,
          user: item.action.user ?? null
        } : {})
      }
    };
  }

  const namespace = item.namespace ?? null;
  const chatName = findChatToolName(toolMap, "function", item.name, namespace) ?? sanitizeToolName(namespace ? `${namespace}${item.name}` : item.name);
  return {
    id: callId,
    type: "function",
    function: {
      name: chatName,
      arguments: item.arguments ?? "{}"
    }
  };
}

function normalizeMessages(messages) {
  return messages.filter((message) => {
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }

    if (message.role === "tool") {
      return Boolean(message.tool_call_id);
    }

    return typeof message.content === "string" && message.content.length > 0;
  });
}

function stringifyMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringifyContent(content);
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return stringifyContent(part);
      }

      if (INPUT_TEXT_TYPES.has(part.type)) {
        return part.text ?? "";
      }

      if (part.type === "input_image") {
        return part.image_url ? `[image: ${part.image_url}]` : "[image]";
      }

      if (part.type === "input_file") {
        return part.filename ? `[file: ${part.filename}]` : "[file]";
      }

      return stringifyContent(part);
    })
    .filter(Boolean)
    .join("\n");
}

function stringifyContent(value) {
  if (value == null) {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function mapRole(role) {
  if (role === "developer") {
    return "system";
  }

  if (role === "tool") {
    return "tool";
  }

  if (role === "assistant") {
    return "assistant";
  }

  return "user";
}

function createToolMap(tools) {
  const toolMap = new Map();
  if (!Array.isArray(tools) || tools.length === 0) {
    return toolMap;
  }

  for (const tool of tools) {
    for (const entry of flattenTool(tool)) {
      toolMap.set(entry.chatName, entry);
    }
  }

  return toolMap;
}

function convertTools(tools, toolMap = createToolMap(tools)) {
  if (!toolMap || toolMap.size === 0) {
    return undefined;
  }

  const functions = [...toolMap.values()]
    .filter((entry) => entry.chatTool)
    .map((entry) => ({
      type: "function",
      function: entry.chatTool
    }));

  return functions.length > 0 ? functions : undefined;
}

function convertToolChoice(toolChoice, toolMap = new Map()) {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "none") {
    return toolChoice;
  }

  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = toolChoice.name ?? toolChoice.function?.name;
    return {
      type: "function",
      function: {
        name: findChatToolName(toolMap, "function", name) ?? sanitizeToolName(name)
      }
    };
  }

  return "auto";
}

function convertReasoningEffort(effort) {
  if (!effort) {
    return undefined;
  }

  if (effort === "xhigh") {
    return "max";
  }

  if (effort === "low" || effort === "medium" || effort === "high") {
    return "high";
  }

  if (effort === "max") {
    return "max";
  }

  return undefined;
}

function convertThinking(reasoning, envThinking) {
  if (envThinking === "enabled" || envThinking === "disabled") {
    return { type: envThinking };
  }

  if (reasoning?.effort === "none") {
    return { type: "disabled" };
  }

  return undefined;
}

function convertResponseFormat(format) {
  if (!format || format.type === "text") {
    return undefined;
  }

  if (format.type === "json_object") {
    return { type: "json_object" };
  }

  return undefined;
}

function flattenTool(tool) {
  if (!tool || typeof tool !== "object") {
    return [];
  }

  if (tool.type === "function") {
    const chatName = sanitizeToolName(tool.name);
    return [{
      type: "function",
      chatName,
      name: tool.name,
      namespace: null,
      chatTool: {
        name: chatName,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} }
      }
    }];
  }

  if (tool.type === "namespace") {
    return (tool.tools ?? [])
      .filter((nested) => nested?.type === "function")
      .map((nested) => {
        const chatName = sanitizeToolName(`${tool.name}${nested.name}`);
        return {
          type: "function",
          chatName,
          name: nested.name,
          namespace: tool.name,
          chatTool: {
            name: chatName,
            description: nested.description ?? "",
            parameters: nested.parameters ?? { type: "object", properties: {} }
          }
        };
      });
  }

  if (tool.type === "custom") {
    const chatName = sanitizeToolName(tool.name);
    return [{
      type: "custom",
      chatName,
      name: tool.name,
      chatTool: {
        name: chatName,
        description: tool.description ?? "",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" }
          },
          required: ["input"]
        }
      }
    }];
  }

  if (tool.type === "local_shell") {
    return [{
      type: "local_shell",
      chatName: "local_shell",
      name: "local_shell",
      chatTool: {
        name: "local_shell",
        description: "Run a local shell command.",
        parameters: LOCAL_SHELL_PARAMETERS
      }
    }];
  }

  return [];
}

function findChatToolName(toolMap, type, name, namespace = null) {
  for (const entry of toolMap.values()) {
    if (entry.type === type && entry.name === name && (namespace == null || entry.namespace === namespace)) {
      return entry.chatName;
    }
  }

  return null;
}

function extractCustomToolInput(argumentsText) {
  const parsed = safeParseJson(argumentsText);
  if (parsed && typeof parsed === "object" && typeof parsed.input === "string") {
    return parsed.input;
  }

  return argumentsText;
}

function extractLocalShellAction(argumentsText) {
  const parsed = safeParseJson(argumentsText);
  if (!parsed || typeof parsed !== "object") {
    return { command: [] };
  }

  return {
    command: Array.isArray(parsed.command) ? parsed.command.map(String) : [],
    ...(parsed.timeout_ms == null ? {} : { timeout_ms: parsed.timeout_ms }),
    ...(parsed.working_directory == null ? {} : { working_directory: parsed.working_directory }),
    ...(parsed.env == null ? {} : { env: parsed.env }),
    ...(parsed.user == null ? {} : { user: parsed.user })
  };
}

function sanitizeToolName(name) {
  const safe = String(name ?? "tool").replace(/[^A-Za-z0-9_-]/g, "_");
  return safe || "tool";
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
