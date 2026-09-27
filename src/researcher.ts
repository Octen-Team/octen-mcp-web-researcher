/**
 * MCP-powered web researcher.
 *
 * Connects to Octen's MCP server (locally over stdio via `npx -y octen-mcp`, or
 * the hosted endpoint over Streamable HTTP), exposes its tools to Claude, and
 * runs a tool-use loop until the model returns a cited answer.
 *
 *   npm run research -- "What changed in the latest MCP spec revision?"
 *   npm run list-tools
 *   npm run research -- --transport http "..."
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type Transport = "stdio" | "http";

const HOSTED_URL = "https://mcp.octen.ai/mcp";
// The research loop only needs these. Filtering keeps tool schemas out of the
// model's context that it would never use (the beta media tools, for example).
export const RESEARCH_TOOLS = ["search", "news_search", "broad_search", "extract"];
const DEFAULT_MODEL = process.env.RESEARCHER_MODEL ?? "claude-sonnet-5";

const SYSTEM_PROMPT = (today: string) => `You are a web researcher. Today's date is ${today}.

You have live web tools served over MCP. Work in this order:
1. Call broad_search ONCE with the whole question. Do not pre-split it; the tool
   decomposes it into sub-queries and runs them concurrently. Use topic="news" for
   recent events, and a time window when the question is time-bound.
2. From the grouped results, pick the 3-6 most authoritative URLs. Prefer primary
   sources (official docs, specs, changelogs, the vendor's own posts). Results are
   not deduplicated across sub-queries, so dedupe by URL.
3. Call extract on those URLs in a single call, without a query, so you read the
   pages themselves. Skip any result whose page structure is "No Main Content".
4. If a specific gap remains, close it with one targeted search or extract.
   Do not repeat broad_search over the same ground.
5. Answer. Every factual claim carries a bracketed citation like [1] that maps to
   a page you actually extracted. End with a "Sources" list of [n] Title - URL.
   Say plainly what you could not establish.`;

/** The slice of the Anthropic client this file uses, so tests can stand in for it. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<{ content: Anthropic.ContentBlock[] }>;
  };
}

// Trace goes to stderr so stdout carries only the final answer.
const log = (msg = "") => process.stderr.write(msg + "\n");
const short = (text: string, width = 160) => {
  const t = text.replace(/\s+/g, " ");
  return t.length <= width ? t : t.slice(0, width - 3) + "...";
};

export async function connect(transport: Transport): Promise<Client> {
  const apiKey = process.env.OCTEN_API_KEY;
  if (!apiKey) throw new Error("OCTEN_API_KEY is not set. Copy .env.example to .env and add your key.");

  const client = new Client({ name: "octen-web-researcher", version: "1.0.0" });

  if (transport === "stdio") {
    await client.connect(new StdioClientTransport({
      command: "npx",
      args: ["-y", "octen-mcp"],
      // The MCP SDK gives the child process only a minimal environment unless
      // you pass one. Pass yours through so npx sees your npm config and any
      // proxy settings, then add what the server needs.
      env: {
        ...(process.env as Record<string, string>),
        OCTEN_API_KEY: apiKey,
        OCTEN_ENABLE_BETA_TOOLS: "false",
      },
      stderr: "inherit",
    }));
  } else {
    const url = new URL(process.env.OCTEN_MCP_URL ?? HOSTED_URL);
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "x-api-key": apiKey } },
    }));
  }
  return client;
}

/** MCP tool definitions map one-to-one onto Anthropic tool definitions. */
export async function loadTools(client: Client): Promise<Anthropic.Tool[]> {
  const { tools } = await client.listTools();
  return tools
    .filter((t) => RESEARCH_TOOLS.includes(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, isError: Boolean(result.isError) };
}

/** Print a compact view of what came back, so the trace stays readable. */
function summarize(name: string, text: string) {
  const lines = text.split("\n");
  if (name === "broad_search") {
    const decomposed = lines.find((l) => l.startsWith("Decomposed into"));
    if (decomposed) {
      const [head, subs] = decomposed.split(/: (.*)/s);
      log(`    ${head}:`);
      for (const s of subs.split(" · ")) log(`      - ${s}`);
    }
    const groups = lines.filter((l) => l.startsWith("# Sub-query:")).length;
    const hits = lines.filter((l) => l.startsWith("## Result ")).length;
    log(`    ${hits} results across ${groups} sub-query groups`);
  } else if (name === "extract") {
    lines.forEach((l, i) => {
      if (!l.startsWith("## Result ")) return;
      const url = l.split(": ").slice(1).join(": ");
      const window = lines.slice(i, i + 8);
      const status = window.find((w) => w.startsWith("**Status:**")) ?? "";
      const structure = window.find((w) => w.startsWith("**Page structure:**")) ?? "";
      log(`    ${url}  ${status}  ${structure}`);
    });
  } else {
    log(`    ${lines.filter((l) => l.startsWith("## Result ")).length} results`);
  }
}

export async function research(opts: {
  question: string;
  transport?: Transport;
  model?: string;
  maxTurns?: number;
  llm?: MessagesClient;
}): Promise<string> {
  const { question, transport = "stdio", model = DEFAULT_MODEL, maxTurns = 8 } = opts;
  const llm: MessagesClient = opts.llm ?? new Anthropic();

  const client = await connect(transport);
  try {
    const tools = await loadTools(client);
    log(`Connected to Octen MCP over ${transport}. Tools: ${tools.map((t) => t.name).join(", ")}`);
    log(`Question: ${question}\n`);

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
    const system = SYSTEM_PROMPT(new Date().toISOString().slice(0, 10));

    for (let turn = 1; turn <= maxTurns; turn++) {
      const response = await llm.messages.create({ model, max_tokens: 8000, system, tools, messages });
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        return response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUses) {
        log(`[turn ${turn}] -> ${block.name} ${short(JSON.stringify(block.input))}`);
        const { text, isError } = await callTool(client, block.name, block.input as Record<string, unknown>);
        if (isError) log(`    ERROR: ${short(text, 300)}`);
        else summarize(block.name, text);
        results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    return "Stopped after reaching --max-turns without a final answer.";
  } finally {
    await client.close();
  }
}

async function listTools(transport: Transport) {
  const client = await connect(transport);
  try {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const first = (t.description ?? "").trim().split("\n")[0];
      console.log(`${t.name.padEnd(14)} ${short(first, 100)}`);
    }
  } finally {
    await client.close();
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      transport: { type: "string", default: "stdio" },
      model: { type: "string", default: DEFAULT_MODEL },
      "max-turns": { type: "string", default: "8" },
      "list-tools": { type: "boolean", default: false },
    },
  });
  const transport = values.transport as Transport;
  if (transport !== "stdio" && transport !== "http") throw new Error("--transport must be stdio or http");

  if (values["list-tools"]) return listTools(transport);

  const question = positionals.join(" ").trim();
  if (!question) throw new Error('Pass a question, e.g. npm run research -- "your question", or use --list-tools');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.");

  const answer = await research({ question, transport, model: values.model, maxTurns: Number(values["max-turns"]) });
  console.log(answer);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
