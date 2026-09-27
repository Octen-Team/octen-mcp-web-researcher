/**
 * Offline end-to-end test.
 *
 * Runs the real `octen-mcp` server over stdio, pointed (via OCTEN_API_URL) at a
 * local mock of the Octen API, and drives research() with a scripted stand-in
 * for the LLM. This exercises the MCP wiring, tool listing, tool calls, result
 * formatting and the agent loop without spending any API credit.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";

const SPEC = "https://modelcontextprotocol.io/specification/2026-07-28/changelog";
const calls: Array<{ path: string; body: any }> = [];

const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    calls.push({ path: req.url ?? "", body });
    assert.equal(req.headers["x-api-key"], "test-key", "API key header not forwarded");

    let payload: unknown = { code: 0, data: { results: [] } };
    if (req.url === "/broad-search") {
      payload = {
        code: 0, request_id: "mock-broad-1",
        data: {
          query: body.query,
          queries: ["MCP specification 2026-07-28 changelog", "MCP stateless protocol initialize removed",
            "MCP server/discover subscriptions/listen"],
          search_results: [
            { query: "MCP specification 2026-07-28 changelog", latency: 120, results: [
              { title: "Key Changes - Model Context Protocol", url: SPEC, time_published: "2026-07-28T00:00:00Z",
                highlight: "Make MCP stateless: remove the initialize handshake." }] },
            { query: "MCP stateless protocol initialize removed", latency: 140, results: [
              { title: "Key Changes - Model Context Protocol", url: SPEC,
                highlight: "Every request now carries its protocol version." }] },
            { query: "MCP server/discover subscriptions/listen", latency: 131, results: [] },
          ],
        },
        meta: { usage: { num_search_queries: 3 }, latency: 812 },
      };
    } else if (req.url === "/extract") {
      payload = {
        code: 0, request_id: "mock-extract-1",
        data: {
          results: body.urls.map((url: string) => ({
            url, status: "success", title: "Key Changes",
            category: { primary: "Computers, Electronics & Technology" },
            page_structure: { primary: "Content Page", secondary: "Documentation" },
            full_content: "Remove protocol-level sessions ... Add server/discover ...",
          })),
          meta: { usage: { total_urls: body.urls.length, successful_urls: body.urls.length }, latency: 950 },
        },
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});

/** Plays the model's side: broad_search, then extract, then a cited answer. */
function scriptedLLM() {
  let turn = 0;
  const seen: string[] = [];
  const lastResult = (msgs: Anthropic.MessageParam[]) =>
    ((msgs.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0].content as string);
  const toolUse = (id: string, name: string, input: object) =>
    ({ type: "tool_use", id, name, input }) as Anthropic.ToolUseBlock;

  return {
    seen,
    messages: {
      async create(p: Anthropic.MessageCreateParamsNonStreaming) {
        turn++;
        seen.splice(0, seen.length, ...(p.tools ?? []).map((t) => (t as Anthropic.Tool).name));
        if (turn === 1) {
          return { content: [toolUse("t1", "broad_search", { query: "What changed in the latest MCP spec revision?", max_queries: 5 })] };
        }
        if (turn === 2) {
          assert.match(lastResult(p.messages), /Decomposed into 3 sub-queries/);
          return { content: [toolUse("t2", "extract", { urls: [SPEC] })] };
        }
        assert.match(lastResult(p.messages), /Page structure:\*\* Content Page/);
        return { content: [{ type: "text", text: `MCP removed the initialize handshake [1].\n\nSources\n[1] Key Changes - ${SPEC}`, citations: null } as Anthropic.TextBlock] };
      },
    },
  };
}

await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const { port } = mock.address() as AddressInfo;
Object.assign(process.env, {
  OCTEN_API_KEY: "test-key",
  OCTEN_API_URL: `http://127.0.0.1:${port}`,
  NO_PROXY: "127.0.0.1,localhost",
});

const { research, RESEARCH_TOOLS } = await import("../src/researcher.js");
const llm = scriptedLLM();
const answer = await research({ question: "What changed in the latest MCP spec revision?", llm, maxTurns: 5 });

assert.deepEqual([...llm.seen].sort(), [...RESEARCH_TOOLS].sort());
assert.deepEqual(calls.map((c) => c.path), ["/broad-search", "/extract"]);
assert.equal(calls[0].body.max_queries, 5);
assert.ok(answer.includes("[1]") && answer.includes(SPEC));

mock.close();
console.log("\nOK: tools listed, broad_search and extract called over MCP, cited answer returned.");
console.log(answer);
