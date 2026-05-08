# Changelog

## 0.0.2

- Fixed standalone executable failing to start due to `import.meta` syntax error in CJS fallback.
- Replaced fragile regex-based bundle stripping with marker-delimited removal for deterministic builds.

## 0.0.1

- Added local `/v1/responses` to DeepSeek Chat Completions proxy.
- Added Codex-compatible text and tool-call SSE conversion.
- Added `reasoning_content` preservation for DeepSeek thinking models.
- Added `deepseek-auto` local routing between `deepseek-v4-flash` and `deepseek-v4-pro`.
- Added standalone executable release packages for Windows, Linux, and macOS.
