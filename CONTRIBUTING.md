# Contributing

Thanks for improving deepseek-response.

## Development

Requirements:

- Node.js 20+
- Windows if you want to build the standalone `.exe`

Common commands:

```powershell
npm test
npm run build:exe
npm run smoke:codex
```

## Pull Request Checklist

- Keep changes scoped to the compatibility surface being touched.
- Do not commit `.env`, real API keys, `.build/`, or `dist/`.
- Add or update tests for request conversion, SSE conversion, routing, or server behavior.
- Run `npm test` before opening the PR.

## Compatibility Notes

This project targets the Responses API shape that Codex CLI consumes. Avoid claiming full public OpenAI Responses API compatibility unless the specific behavior is implemented and tested.
