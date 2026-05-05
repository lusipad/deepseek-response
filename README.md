# deepseek2response

本项目是一个本地 Responses-compatible 代理，把 Codex CLI 实际使用的 OpenAI Responses API surface 转换成 DeepSeek 的 OpenAI-compatible Chat Completions 请求。

## 当前假设

- Codex 自定义 provider 走 `wire_api = "responses"`，因此本地代理必须暴露 `/v1/responses`。
- DeepSeek V4 当前走 `/chat/completions`，不是 OpenAI Responses API。
- 兼容目标是 Codex CLI 的 Responses surface，不是完整复刻 OpenAI 公共 Responses API 的所有多模态和托管工具能力。

## 支持范围

- `POST /v1/responses` 非流式文本输出。
- `POST /v1/responses` Codex 可接受的 SSE 文本流转换。
- `POST /v1/responses` Codex 可接受的 SSE function call 生命周期。
- Responses `input` / `instructions` 到 Chat Completions `messages` 的转换。
- Codex function / namespace / custom / local_shell tools 到 Chat Completions function tools 的转换。
- Chat Completions tool calls 回写为 Codex 可回放的 `function_call` / `custom_tool_call` / `local_shell_call` items。
- `function_call_output` 到 Chat `tool` message 的转换。
- `custom_tool_call_output` / `tool_search_output` 到 Chat `tool` message 的转换。
- `GET /v1/responses/:id` 的进程内 retrieve。
- DeepSeek `reasoning_content` 的进程内保留，并在 Codex 后续轮次传回相同 assistant message 时补回。
- `deepseek-auto` 本地模型路由：Codex 只配一个模型，代理按请求选择 `deepseek-v4-flash` 或 `deepseek-v4-pro`，并在 429/5xx/timeout 时切到备用模型重试。

## 暂不支持

- OpenAI 公共 Responses API 的完整多模态/托管工具语义。
- 多进程持久化 conversation store。
- 图片、文件、多模态输入的原生转发。
- Codex 未观测到的 response id / previous response 边界行为。

## 公开反馈对照

| 公开反馈 | 当前处理 |
| --- | --- |
| provider 只有 Chat Completions 时，`/v1/responses` 不能直接转发 | 已处理：代理本地实现 `/v1/responses`，再调用 DeepSeek `/chat/completions`。 |
| Responses SSE 缺少 active output item 会导致 Codex 断流 | 已处理：按 Codex 接受的 `output_item` / `content_part` / `output_text` 生命周期发事件。 |
| DeepSeek V4 thinking 多轮要求回传 `reasoning_content` | 已处理：保留非流式和流式 `reasoning_content`，并在 Codex 后续轮次传回相同 assistant message 时补回。 |
| tool call streaming 分片需要拼成完整函数调用 | 已处理：聚合 ChatCompletions `tool_calls` delta，输出 Responses `function_call` 生命周期。 |
| Responses-only 参数直接透传会触发兼容层错误 | 已处理：只向 DeepSeek 发送 ChatCompletions 字段，并映射 `reasoning.effort`、`text.format` 等兼容参数。 |
| 空 assistant content / 非标准 role 可能被后端拒绝 | 已处理：`developer` 映射为 `system`，空非工具消息在发送前清洗。 |

## 运行

普通本地使用只需要：

```powershell
copy .env.example .env
notepad .env
.\Start DeepSeek2Response Exe.cmd
```

默认监听：

```text
http://127.0.0.1:18488
```

如果只想分发最小运行包，使用 `dist\deepseek2response.exe` 加同目录 `.env` 即可。开发仓库里也可以直接启动 `dist\deepseek2response.exe`，它会先找 `dist\.env`，找不到时读取仓库根目录 `.env`。

`.env` 里默认使用本地自动路由：

```env
DEEPSEEK_MODEL=deepseek-auto
DEEPSEEK_ROUTER_FAST_MODEL=deepseek-v4-flash
DEEPSEEK_ROUTER_PRO_MODEL=deepseek-v4-pro
DEEPSEEK_ROUTER_DEFAULT=pro
DEEPSEEK_ROUTER_SIMPLE_NO_TOOL=fast
DEEPSEEK_ROUTER_FALLBACK=enabled
```

路由规则保持简单：显式写 `deepseek-v4-pro` / `deepseek-v4-flash` 时不改模型；只有请求模型是 `deepseek-auto` 时才本地选择。高 reasoning、工具回合、大输入走 Pro；短单轮用户请求走 Flash；默认走 Pro。

## Codex 配置示例

把 `codex-config.example.toml` 里的片段加入你的 Codex 用户配置文件后，可以通过 `-p deepseek2response` 使用。

```toml
[profiles.deepseek2response]
model_provider = "deepseek2response"
model = "deepseek-auto"

[model_providers.deepseek2response]
name = "deepseek2response"
base_url = "http://127.0.0.1:18488/v1"
env_key = "DEEPSEEK2RESPONSE_API_KEY"
wire_api = "responses"
```

本地代理只用 `DEEPSEEK2RESPONSE_API_KEY` 满足 Codex 的 provider 校验；它可以保持原来的 SK 或任意本地占位值。真正调用 DeepSeek 使用 `.env` 里的 `DEEPSEEK_API_KEY`。

开发时也可以直接运行：

```powershell
npm start
```

仍想用 Node 源码直启时，可以运行：

```powershell
.\Start DeepSeek2Response.cmd
```

## 验证

```powershell
npm test
```

编译 standalone exe：

```powershell
npm run build:exe
```

跑真实 Codex CLI 到 mock DeepSeek 的 conformance smoke：

```powershell
npm run smoke:codex
```

这个 smoke 会验证 Codex 能接收代理的 Responses SSE 文本流、发起 function call、执行本地 shell，并把 tool output 回传给下一轮模型。

代理启动后，可以运行本地 smoke：

```powershell
$env:DEEPSEEK2RESPONSE_URL="http://127.0.0.1:18488/v1"
npm run smoke:local
```

需要用真实 DeepSeek API 做手动验证时，先确认 `.env` 里已经配置真实 `DEEPSEEK_API_KEY`，然后运行：

```powershell
npm run build:exe
npm run smoke:real -- -StartProxy
```

`smoke:real` 默认会跑三个探针：`deepseek-auto` 短请求、`reasoning.high` 路由到 Pro、以及 Responses SSE 流式请求。输出只包含状态、路由模型、响应长度和是否包含 `OK`，不会打印完整模型正文。需要排障时可以加 `-IncludeText`。

也可以回放本地保存的真实 Codex `/v1/responses` 请求：

```powershell
npm run smoke:real -- -Fixture fixtures\codex-request.fixture.json -StartProxy
```

`fixtures/` 和 `*.fixture.json` 默认不进 git。真实请求样本可能包含本地路径、提示词、工具参数或其他敏感信息，提交前必须脱敏。

也可以用 Codex 做一次最小探测：

```powershell
$env:DEEPSEEK2RESPONSE_API_KEY="local"
codex exec --skip-git-repo-check -p deepseek2response "只回复 OK"
```

## 设计原则

目标是先做到 Codex CLI 视角的完全兼容，再按真实失败扩展边界。当前转换参考了 Codex CLI 0.128.0 的 Responses request / SSE parser / `ResponseItem` 形态：核心兼容对象是 Codex 能解析、执行、回放到下一轮的 Responses item，而不是 OpenAI 公共 Responses API 的全集。

下一步最值得补的是：真实 DeepSeek V4 Pro 多轮 `reasoning_content` 回归、落盘 store、并发会话隔离，以及更多 Codex tool call 分片形态测试。
