import test from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler } from "../src/context-assembler.ts";

test("context assembler trims raw history and tool payloads before model calls", () => {
  const assembler = new ContextAssembler({
    maxInputTokens: 1800,
    historyTokenBudget: 400,
    currentTurnTokenBudget: 900,
    toolTokenBudget: 300,
    toolResultTokenBudget: 120
  });
  const huge = "x".repeat(20_000);
  const transcript = [
    { role: "user", content: [{ text: huge }] },
    { role: "assistant", content: [{ text: huge }] },
    {
      role: "user",
      content: [{
        toolResult: {
          toolUseId: "t1",
          status: "success",
          content: [{ text: JSON.stringify({ raw: huge }) }]
        }
      }]
    },
    { role: "user", content: [{ text: "fix dashboard token issue" }] }
  ];

  const result = assembler.assemble({
    transcript,
    currentTurnStart: 3,
    tools: Array.from({ length: 20 }, (_, index) => ({
      name: `tool_${index}`,
      description: huge,
      inputSchema: { type: "object", properties: { query: { type: "string", description: huge } } }
    })),
    systemPrompt: "system",
    sessionSummary: "older context",
    runtimeContext: "local index refs"
  });

  assert.ok(result.report.totalTokens <= result.report.maxInputTokens);
  assert.ok(result.report.messagesOut < transcript.length + 2);
  assert.equal(result.report.toolsOut, 20);
  assert.doesNotMatch(JSON.stringify(result.messages), new RegExp(`x{5000}`));
});
