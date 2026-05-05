const AUTO_MODEL = "deepseek-auto";
const DEFAULT_FAST_MODEL = "deepseek-v4-flash";
const DEFAULT_PRO_MODEL = "deepseek-v4-pro";
const DEFAULT_LARGE_INPUT_CHARS = 12000;
const DEFAULT_SIMPLE_INPUT_CHARS = 2000;

const TOOL_LOOP_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "tool_search_output"
]);

export function selectDeepSeekModel({ requestedModel, responsesRequest, chatPayload, env = process.env } = {}) {
  const config = readRouterConfig(env);
  const model = requestedModel || env.DEEPSEEK_MODEL || config.proModel;

  if (model !== config.autoModel) {
    return {
      requestedModel: model,
      model,
      routed: false,
      lane: "explicit",
      reason: "explicit_model",
      fallbackModel: null,
      fallbackEnabled: false
    };
  }

  const decision = chooseLane(responsesRequest, chatPayload, config);
  const selectedModel = modelForLane(decision.lane, config);
  const fallbackModel = config.fallbackEnabled ? alternateModelForLane(decision.lane, config) : null;

  return {
    requestedModel: model,
    model: selectedModel,
    routed: true,
    lane: decision.lane,
    reason: decision.reason,
    fallbackModel: fallbackModel === selectedModel ? null : fallbackModel,
    fallbackEnabled: Boolean(config.fallbackEnabled && fallbackModel && fallbackModel !== selectedModel)
  };
}

export function isRetryableUpstreamError(error) {
  const status = Number(error?.status);
  if (status === 408 || status === 429 || status >= 500) {
    return true;
  }

  return error?.name === "AbortError" || error?.code === "ETIMEDOUT";
}

function chooseLane(request, chatPayload, config) {
  if (isHighReasoning(request)) {
    return { lane: "pro", reason: "high_reasoning" };
  }

  if (hasToolLoop(request, chatPayload)) {
    return { lane: "pro", reason: "tool_loop" };
  }

  if (inputSize(chatPayload) >= config.largeInputChars) {
    return { lane: "pro", reason: "large_input" };
  }

  if (isSimpleUserTurn(chatPayload, config)) {
    return { lane: config.simpleNoToolLane, reason: "simple_user_turn" };
  }

  return { lane: config.defaultLane, reason: "default" };
}

function readRouterConfig(env) {
  return {
    autoModel: env.DEEPSEEK_ROUTER_AUTO_MODEL || AUTO_MODEL,
    fastModel: env.DEEPSEEK_ROUTER_FAST_MODEL || DEFAULT_FAST_MODEL,
    proModel: env.DEEPSEEK_ROUTER_PRO_MODEL || DEFAULT_PRO_MODEL,
    defaultLane: normalizeLane(env.DEEPSEEK_ROUTER_DEFAULT, "pro"),
    simpleNoToolLane: normalizeLane(env.DEEPSEEK_ROUTER_SIMPLE_NO_TOOL, "fast"),
    fallbackEnabled: isEnabled(env.DEEPSEEK_ROUTER_FALLBACK, true),
    largeInputChars: positiveInteger(env.DEEPSEEK_ROUTER_LARGE_INPUT_CHARS, DEFAULT_LARGE_INPUT_CHARS),
    simpleInputChars: positiveInteger(env.DEEPSEEK_ROUTER_SIMPLE_INPUT_CHARS, DEFAULT_SIMPLE_INPUT_CHARS)
  };
}

function isHighReasoning(request) {
  return ["high", "xhigh", "max"].includes(request?.reasoning?.effort);
}

function hasToolLoop(request, chatPayload) {
  const inputItems = Array.isArray(request?.input) ? request.input : [];
  if (inputItems.some((item) => TOOL_LOOP_ITEM_TYPES.has(item?.type))) {
    return true;
  }

  return (chatPayload?.messages ?? []).some((message) => {
    if (message.role === "tool") {
      return true;
    }

    return message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  });
}

function inputSize(chatPayload) {
  return JSON.stringify(chatPayload?.messages ?? []).length;
}

function isSimpleUserTurn(chatPayload, config) {
  const messages = chatPayload?.messages ?? [];
  const nonSystemMessages = messages.filter((message) => message.role !== "system");

  if (nonSystemMessages.length !== 1 || nonSystemMessages[0].role !== "user") {
    return false;
  }

  return inputSize(chatPayload) <= config.simpleInputChars;
}

function modelForLane(lane, config) {
  return lane === "fast" ? config.fastModel : config.proModel;
}

function alternateModelForLane(lane, config) {
  return lane === "fast" ? config.proModel : config.fastModel;
}

function normalizeLane(value, fallback) {
  return value === "fast" || value === "pro" ? value : fallback;
}

function isEnabled(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return !["0", "false", "disabled", "off", "no"].includes(String(value).toLowerCase());
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
