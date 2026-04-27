/**
 * Tests for sanitizeLlmOutput() — Plan 01-03
 *
 * These tests verify that the sanitizeLlmOutput function correctly strips
 * internal CoT tags, artifact wrappers, and repairs malformed output
 * before rendering to the user.
 *
 * TDD: RED phase — tests written before implementation exists.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Import the exported standalone function for unit testing
// This will fail until sanitizeLlmOutput is exported from agent-loop.ts
import { sanitizeLlmOutput } from "../src/agent-loop.ts";

// Test 1: Strip <thinking>...</thinking> blocks completely
test("sanitizeLlmOutput strips <thinking> blocks and their content", () => {
  const input = "<thinking>This is internal reasoning that should not be shown.</thinking>Here is the real answer.";
  const result = sanitizeLlmOutput(input);
  assert.ok(!result.includes("<thinking>"), "Should not contain <thinking> tag");
  assert.ok(!result.includes("internal reasoning"), "Should not contain thought content");
  assert.ok(result.includes("Here is the real answer"), "Should preserve real content");
});

// Test 2: Strip <thought>...</thought> blocks completely
test("sanitizeLlmOutput strips <thought> blocks and their content", () => {
  const input = "<thought>Let me think about this step by step.</thought>The answer is 42.";
  const result = sanitizeLlmOutput(input);
  assert.ok(!result.includes("<thought>"), "Should not contain <thought> tag");
  assert.ok(!result.includes("Let me think"), "Should not contain thought content");
  assert.ok(result.includes("The answer is 42"), "Should preserve real content");
});

// Test 3: Remove artifact/result/answer wrapper tags but KEEP text content
test("sanitizeLlmOutput removes <artifact>, <result>, <answer> tags but keeps their content", () => {
  const artifactInput = "<artifact>This is useful content inside an artifact tag.</artifact>";
  const resultInput = "<result>The computation result is important.</result>";
  const answerInput = "<answer>The final answer you want to see.</answer>";

  const r1 = sanitizeLlmOutput(artifactInput);
  assert.ok(!r1.includes("<artifact>"), "Should remove <artifact> open tag");
  assert.ok(!r1.includes("</artifact>"), "Should remove </artifact> close tag");
  assert.ok(r1.includes("This is useful content"), "Should preserve artifact content");

  const r2 = sanitizeLlmOutput(resultInput);
  assert.ok(!r2.includes("<result>"), "Should remove <result> open tag");
  assert.ok(r2.includes("computation result"), "Should preserve result content");

  const r3 = sanitizeLlmOutput(answerInput);
  assert.ok(!r3.includes("<answer>"), "Should remove <answer> open tag");
  assert.ok(r3.includes("final answer"), "Should preserve answer content");
});

// Test 4: Preserve normal markdown and code blocks unchanged
test("sanitizeLlmOutput preserves normal markdown and code blocks", () => {
  const markdown = "# Heading\n\nSome **bold** text and `inline code`.\n\n```javascript\nconst x = 1;\n```\n\n- item 1\n- item 2";
  const result = sanitizeLlmOutput(markdown);
  assert.ok(result.includes("# Heading"), "Should preserve markdown headings");
  assert.ok(result.includes("**bold**"), "Should preserve bold markdown");
  assert.ok(result.includes("`inline code`"), "Should preserve inline code");
  assert.ok(result.includes("```javascript"), "Should preserve code fences");
  assert.ok(result.includes("const x = 1;"), "Should preserve code content");
  assert.ok(result.includes("- item 1"), "Should preserve list items");
});

// Test 5: Close unclosed code fences (odd fenceCount appends closing ```)
test("sanitizeLlmOutput closes unclosed code fences when fenceCount is odd", () => {
  const unclosed = "Here is some code:\n```python\ndef hello():\n    print('hello')\n";
  const result = sanitizeLlmOutput(unclosed);
  const fenceCount = (result.match(/^```/gm) || []).length;
  assert.equal(fenceCount % 2, 0, "Code fences should be balanced (even count)");
  // Original had 1 fence, so result should have 2
  assert.equal(fenceCount, 2, "Should have added a closing fence");
});

// Test 6: Do NOT add closing fence when fences are already balanced
test("sanitizeLlmOutput does not modify balanced code fences", () => {
  const balanced = "```python\nprint('hello')\n```";
  const result = sanitizeLlmOutput(balanced);
  const fenceCount = (result.match(/^```/gm) || []).length;
  assert.equal(fenceCount, 2, "Should still have exactly 2 fences");
});

// Test 7: Strip orphaned | table rows (lines that are only | and whitespace)
test("sanitizeLlmOutput strips orphaned pipe-only table rows", () => {
  const withOrphanedPipes = "| Header 1 | Header 2 |\n|\n|    |\n| real row | data |";
  const result = sanitizeLlmOutput(withOrphanedPipes);
  assert.ok(!result.match(/^\s*\|\s*$/m), "Should not contain orphaned pipe-only rows");
  assert.ok(result.includes("| Header 1 |"), "Should preserve real table rows");
  assert.ok(result.includes("| real row |"), "Should preserve real data rows");
});

// Test 8: renderAssistantTurn integration — output should not contain <thinking> content
// This test is structural: we verify that the export function mirrors private method behavior.
// The renderAssistantTurn is tested through the public export since AgentLoop requires config.
test("sanitizeLlmOutput handles multiline thinking block followed by real content", () => {
  const complex = `<thinking>
Let me analyze this question carefully.
First, I consider the inputs.
Then I formulate a response.
</thinking>

Here is my actual response to you.

\`\`\`typescript
const example = "code";
\`\`\``;
  const result = sanitizeLlmOutput(complex);
  assert.ok(!result.includes("<thinking>"), "Should remove thinking open tag");
  assert.ok(!result.includes("</thinking>"), "Should remove thinking close tag");
  assert.ok(!result.includes("Let me analyze"), "Should remove thinking content");
  assert.ok(!result.includes("formulate a response"), "Should remove all thinking content");
  assert.ok(result.includes("Here is my actual response"), "Should preserve real content");
  assert.ok(result.includes("const example"), "Should preserve code content");
});
