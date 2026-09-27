# MCP-powered web researcher on Octen

Companion code for the Octen tutorial **How to Build an MCP-Powered Web Researcher**.

An agent that takes a question, uses live web search and page extraction served over MCP by [Octen's MCP server](https://github.com/Octen-Team/octen-mcp), and returns an answer with numbered citations.

There are two ways to run it:

1. **In an MCP client you already use** (Claude Code, Cursor, and others). Add the server config from `configs/` and paste the prompt from `prompts/research-task.md`.
2. **As a small custom agent** (`src/researcher.ts`). It uses the MCP TypeScript SDK to start Octen's MCP server, hands its tools to Claude, and runs the tool-use loop itself, printing a trace of every call.

## Prerequisites

- Node.js 18.17 or later
- An Octen API key from [octen.ai/platform/api-keys](https://octen.ai/platform/api-keys). New accounts get a free starting balance, see [pricing](https://docs.octen.ai/overview/pricing).
- An Anthropic API key (for the custom agent only)

## Quick start

```bash
git clone https://github.com/Octen-Team/octen-mcp-web-researcher.git
cd octen-mcp-web-researcher
npm install
cp .env.example .env   # then add OCTEN_API_KEY and ANTHROPIC_API_KEY

npm run list-tools
npm run research -- "What changed in the latest revision of the Model Context Protocol spec, and what does it mean for people running MCP servers?"
```

The trace (tool calls, sub-queries, extracted pages) goes to stderr and the cited answer goes to stdout, so `npm run -s research -- "..." > answer.md` saves only the answer.

Options (pass after `--`):

| Flag | Default | Notes |
|---|---|---|
| `--transport stdio\|http` | `stdio` | `stdio` runs `npx -y octen-mcp` locally; `http` uses the hosted endpoint `https://mcp.octen.ai/mcp` |
| `--model` | `claude-sonnet-5` | Or set `RESEARCHER_MODEL` in `.env` |
| `--max-turns` | `8` | Upper bound on model turns before giving up |
| `--list-tools` | | Print the server's tools and exit |

## Using it from Claude Code or Cursor

```bash
# Claude Code
claude mcp add --scope user octen -e OCTEN_API_KEY=your-key-here -- npx -y octen-mcp
```

For Cursor, merge `configs/cursor.mcp.json` into `~/.cursor/mcp.json` and restart Cursor. `configs/hosted.mcp.json` is the hosted-endpoint form.

## Offline test

`npm test` runs the real `octen-mcp` server against a local mock of the Octen API and a scripted stand-in for the model. It checks the MCP wiring and the agent loop without spending credit. `npm run typecheck` runs the TypeScript compiler.

## License

MIT
