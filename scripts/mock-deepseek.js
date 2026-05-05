import http from "node:http";

const port = Number(process.env.MOCK_DEEPSEEK_PORT || 18588);
const host = process.env.MOCK_DEEPSEEK_HOST || "127.0.0.1";
let toolScenarioCalls = 0;

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "POST" && request.url === "/chat/completions") {
    const body = await readJson(request);
    const scenario = process.env.MOCK_DEEPSEEK_SCENARIO || "text";

    if (scenario === "tool") {
      toolScenarioCalls += 1;
      await handleToolScenario(response, body, toolScenarioCalls);
      return;
    }

    if (body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache"
      });
      writeChatChunk(response, body.model, { content: "OK" });
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_mock",
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "OK",
            reasoning_content: "mock reasoning"
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2
      }
    }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, host, () => {
  console.log(`mock DeepSeek listening on http://${host}:${port}`);
});

function writeChatChunk(response, model, delta) {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl_mock",
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null
      }
    ]
  })}\n\n`);
}

async function handleToolScenario(response, body, callNumber) {
  if (body.stream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache"
    });

    if (callNumber === 1) {
      writeChatChunk(response, body.model, {
        tool_calls: [
          {
            index: 0,
            id: "call_mock_shell",
            type: "function",
            function: {
              name: "shell",
              arguments: "{\"command\":[\"powershell.exe\",\"-Command\",\"Write-Output OK\"]}"
            }
          }
        ]
      });
    } else {
      writeChatChunk(response, body.model, { content: "OK" });
    }

    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `chatcmpl_mock_${callNumber}`,
    object: "chat.completion",
    model: body.model,
    choices: [
      callNumber === 1
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_mock_shell",
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: "{\"command\":[\"powershell.exe\",\"-Command\",\"Write-Output OK\"]}"
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        : {
            index: 0,
            message: {
              role: "assistant",
              content: "OK"
            },
            finish_reason: "stop"
          }
    ]
  }));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }

  return body ? JSON.parse(body) : {};
}
