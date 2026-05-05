const responses = new Map();
const assistantMemories = new Map();

export function saveResponse(response) {
  responses.set(response.id, response);
}

export function getResponse(id) {
  return responses.get(id);
}

export function getAssistantMemories(key) {
  if (!key) {
    return [];
  }

  return assistantMemories.get(key) ?? [];
}

export function saveAssistantMemory(key, assistantMessage) {
  if (!key || !assistantMessage?.reasoning_content) {
    return;
  }

  const existing = assistantMemories.get(key) ?? [];
  const signature = createAssistantSignature(assistantMessage);
  if (signature && existing.some((memory) => memory.signature === signature)) {
    return;
  }

  assistantMemories.set(key, [
    ...existing,
    {
      signature,
      reasoning_content: assistantMessage.reasoning_content
    }
  ]);
}

export function clearStore() {
  responses.clear();
  assistantMemories.clear();
}

function createAssistantSignature(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return `tools:${message.tool_calls.map((toolCall) => `${toolCall.id}:${toolCall.function?.name}:${toolCall.function?.arguments}`).join("|")}`;
  }

  return `text:${message.content ?? ""}`;
}
