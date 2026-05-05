import assert from "node:assert/strict";
import test from "node:test";
import { appendResponseToConversation, chatToResponse, responsesToChat } from "../src/convert.js";

test("converts a Responses request into a Chat Completions request", () => {
  const { chatRequest: chat } = responsesToChat({
    model: "deepseek-v4-pro",
    instructions: "system rules",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }]
      }
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "run a command",
        parameters: { type: "object", properties: { command: { type: "string" } } }
      }
    ],
    tool_choice: "auto",
    stream: false
  });

  assert.equal(chat.model, "deepseek-v4-pro");
  assert.deepEqual(chat.messages, [
    { role: "system", content: "system rules" },
    { role: "user", content: "hello" }
  ]);
  assert.equal(chat.tools[0].function.name, "shell");
  assert.equal(chat.tool_choice, "auto");
  assert.equal(chat.stream, false);
});

test("converts Chat Completions text into a Responses object", () => {
  const response = chatToResponse({
    model: "deepseek-v4-pro",
    choices: [{ message: { role: "assistant", content: "OK" } }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  });

  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "OK");
  assert.equal(response.output[0].content[0].type, "output_text");
  assert.equal(response.usage.total_tokens, 3);
});

test("preserves reasoning_content in local conversation memory", () => {
  const messages = [{ role: "user", content: "one" }];
  const next = appendResponseToConversation(messages, {
    choices: [
      {
        message: {
          role: "assistant",
          content: "two",
          reasoning_content: "hidden chain"
        }
      }
    ]
  });

  assert.equal(next[1].reasoning_content, "hidden chain");
});

test("maps Responses function call outputs to Chat tool messages", () => {
  const { chatRequest: chat } = responsesToChat({
    model: "deepseek-v4-pro",
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "done"
      }
    ]
  });

  assert.deepEqual(chat.messages, [
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "done"
    }
  ]);
});

test("maps Responses reasoning and JSON format knobs to DeepSeek-compatible fields", () => {
  const oldThinking = process.env.DEEPSEEK_THINKING;

  try {
    process.env.DEEPSEEK_THINKING = "enabled";
    const { chatRequest: chat } = responsesToChat({
      model: "deepseek-v4-pro",
      input: "json please",
      reasoning: { effort: "xhigh" },
      text: { format: { type: "json_object" } }
    });

    assert.equal(chat.reasoning_effort, "max");
    assert.deepEqual(chat.thinking, { type: "enabled" });
    assert.deepEqual(chat.response_format, { type: "json_object" });
  } finally {
    if (oldThinking === undefined) {
      delete process.env.DEEPSEEK_THINKING;
    } else {
      process.env.DEEPSEEK_THINKING = oldThinking;
    }
  }
});

test("drops empty non-tool messages before calling Chat Completions", () => {
  const { chatRequest: chat } = responsesToChat({
    model: "deepseek-v4-pro",
    input: [
      { type: "message", role: "assistant", content: [] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] }
    ]
  });

  assert.deepEqual(chat.messages, [{ role: "user", content: "keep" }]);
});

test("maps Codex namespace tools through Chat functions and restores namespace on output", () => {
  const { chatRequest: chat, toolMap } = responsesToChat({
    model: "deepseek-v4-pro",
    input: "use mcp",
    tools: [
      {
        type: "namespace",
        name: "mcp__demo__",
        description: "Demo tools",
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
  });

  assert.equal(chat.tools[0].function.name, "mcp__demo__lookup");

  const response = chatToResponse({
    model: "deepseek-v4-pro",
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
  }, "deepseek-v4-pro", toolMap);

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].namespace, "mcp__demo__");
  assert.equal(response.output[0].name, "lookup");
});

test("maps Codex custom tools through Chat functions and restores custom_tool_call output", () => {
  const { chatRequest: chat, toolMap } = responsesToChat({
    model: "deepseek-v4-pro",
    input: "patch",
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" }
      }
    ]
  });

  assert.equal(chat.tools[0].function.name, "apply_patch");
  assert.deepEqual(chat.tools[0].function.parameters.required, ["input"]);

  const response = chatToResponse({
    model: "deepseek-v4-pro",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_patch",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
              }
            }
          ]
        }
      }
    ]
  }, "deepseek-v4-pro", toolMap);

  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "apply_patch");
  assert.equal(response.output[0].input, "*** Begin Patch\n*** End Patch");
});

test("maps Codex local_shell through Chat functions and restores local_shell_call output", () => {
  const { chatRequest: chat, toolMap } = responsesToChat({
    model: "deepseek-v4-pro",
    input: "run",
    tools: [{ type: "local_shell" }]
  });

  assert.equal(chat.tools[0].function.name, "local_shell");

  const response = chatToResponse({
    model: "deepseek-v4-pro",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_shell",
              type: "function",
              function: {
                name: "local_shell",
                arguments: "{\"command\":[\"powershell.exe\",\"-Command\",\"Write-Output OK\"]}"
              }
            }
          ]
        }
      }
    ]
  }, "deepseek-v4-pro", toolMap);

  assert.equal(response.output[0].type, "local_shell_call");
  assert.deepEqual(response.output[0].action.command, ["powershell.exe", "-Command", "Write-Output OK"]);
});

test("maps replayed Codex tool items back to Chat tool call history", () => {
  const { chatRequest: chat } = responsesToChat({
    model: "deepseek-v4-pro",
    input: [
      {
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        input: "*** Begin Patch\n*** End Patch"
      },
      {
        type: "custom_tool_call_output",
        call_id: "call_patch",
        output: "ok"
      },
      {
        type: "local_shell_call",
        call_id: "call_shell",
        status: "completed",
        action: {
          type: "exec",
          command: ["echo", "OK"]
        }
      },
      {
        type: "function_call_output",
        call_id: "call_shell",
        output: "OK"
      }
    ],
    tools: [
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" }
      },
      { type: "local_shell" }
    ]
  });

  assert.equal(chat.messages[0].role, "assistant");
  assert.equal(chat.messages[0].tool_calls[0].function.name, "apply_patch");
  assert.equal(chat.messages[1].role, "tool");
  assert.equal(chat.messages[2].tool_calls[0].function.name, "local_shell");
  assert.equal(chat.messages[3].content, "OK");
});
