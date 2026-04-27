# Testing Patterns

**Analysis Date:** 2026-04-27

## Test Framework

**Runner:**
- Node.js built-in `node:test` module (ES module syntax)
- Version: Node 20+ (from package.json: `"@types/node": "^20.11.24"`)
- Config: `scripts/run-tests.cjs` - custom test discovery and runner

**Assertion Library:**
- `node:assert` (strict mode: `assert/strict`)
- Used as: `import assert from "node:assert/strict"`

**Run Commands:**
```bash
npm test                    # Run all tests via scripts/run-tests.cjs
```

**Test Discovery:**
- `scripts/run-tests.cjs` walks directory tree looking for `*.test.mjs` or `*.spec.mjs` files
- Skip directories: `.git`, `.mesh`, `benchmarks`, `dist`, `mesh-core`, `node_modules`, `worker`
- Skip hidden directories (starting with `.`)
- Uses `node --import tsx --test` to execute TypeScript via tsx loader

## Test File Organization

**Location:**
- Tests co-located in `tests/` directory at project root (not co-located with source)
- Tests importable from compiled source: `import { AuthManager } from "../src/auth.js"`

**Naming:**
- Pattern: `[module-name].test.mjs` (e.g., `auth.test.mjs`, `llm-client.test.mjs`)
- Alternative: `[module-name].spec.mjs` (not used in codebase but supported)
- File type: `.mjs` (explicit ES module) or `.js` when compiled

**Test Files Present:**
- `tests/timeline-manager.test.mjs` - Timeline functionality
- `tests/tool-validation-and-safety.test.mjs` - Tool safety checks
- `tests/auth.test.mjs` - Authentication flows
- `tests/runtime-observer.test.mjs` - Runtime crash capture
- `tests/context-assembler.test.mjs` - Message assembly/truncation
- `tests/runtime-node-options.test.mjs` - Node.js flag validation
- `tests/moonshots.test.mjs` - Autonomous feature tests
- `tests/moonshot-os.test.mjs` - Autonomous OS tests
- `tests/cache-and-streaming.test.mjs` - Cache and streaming behavior
- `tests/public-surfaces.test.mjs` - Public API contracts
- `tests/docs-and-xray.test.js` - Documentation tests
- `tests/llm-client.test.mjs` - LLM client behavior

## Test Structure

**Suite Organization:**
```typescript
import test from "node:test";
import assert from "node:assert/strict";

test("Feature Name", async (t) => {
  // Shared setup
  
  await t.test("Sub-test 1: specific behavior", async () => {
    // Arrange
    // Act
    // Assert
  });

  await t.test("Sub-test 2: alternative behavior", async () => {
    // Arrange
    // Act
    // Assert
  });

  // Cleanup (optional)
});
```

**Patterns:**
- Top-level test defined with `test("Description", async (t) => { ... })`
- Subtests nested with `await t.test("Sub-test", async () => { ... })`
- Async tests default; use `.finally()` or try/finally for cleanup
- Afterhook pattern: `t.afterEach(() => { ... })` for test isolation

**Example from `auth.test.mjs`:**
```typescript
test("AuthManager - Unit Tests", async (t) => {
  // Save originals
  const originalReadFile = fs.readFile;
  
  t.afterEach(() => {
    // Restore after each sub-test
    fs.readFile = originalReadFile;
  });

  await t.test("Restores session from file successfully", async () => {
    // Mock fs.readFile
    fs.readFile = async (filePath) => { ... };
    // Test logic
    const user = await auth.ensureAuthenticated();
    assert.deepStrictEqual(user, { ... });
  });
});
```

## Mocking

**Framework:** Manual mocking via function replacement

**Patterns:**
```typescript
// 1. Spy/Mock by reassigning
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  requestedUrls.push(String(url));
  return new Response(JSON.stringify({ ... }), { status: 200 });
};

try {
  // Test code using fetch
} finally {
  globalThis.fetch = originalFetch;
}
```

**Mock Injection:**
```typescript
// 2. Monkey-patch object methods
auth.supabase = {
  auth: {
    setSession: async () => ({
      data: { session: {...}, user: {...} },
      error: null
    })
  }
};
```

**File System Mocking (fs/promises):**
```typescript
fs.readFile = async (filePath) => {
  if (filePath === EXPECTED_PATH) {
    return JSON.stringify({ data: "value" });
  }
  throw new Error("File not found");
};
```

**What to Mock:**
- External HTTP calls (`fetch`)
- File system operations (`fs.readFile`, `fs.writeFile`)
- Date/time: `Date.now()` replacement if testing time-dependent logic
- Third-party SDKs: Supabase client methods, keytar password manager
- Child process execution: `spawn`, `exec` for safety tests

**What NOT to Mock:**
- JSON parsing/serialization (test error handling on bad JSON)
- Array methods and JavaScript built-ins
- Error construction (`new Error()`)
- Type guard functions (`isSessionShape()`)

## Fixtures and Factories

**Test Data:**
- Inline JSON objects for simple payloads:
```typescript
const mockSession = {
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token"
};
```

- Large/complex data generated in test: `"x".repeat(20_000)` for payload size tests

**Location:**
- No separate fixtures directory; fixtures defined inline in test file
- Reused mock constructors via helper functions shown in tests
- Constants for expected paths: `MOCK_SESSION_FILE = path.join(os.homedir(), ".config", "mesh", "session.json")`

**Example:**
```typescript
// From context-assembler.test.mjs
const huge = "x".repeat(20_000);
const transcript = [
  { role: "user", content: [{ text: huge }] },
  { role: "assistant", content: [{ text: huge }] }
  // ... more messages
];
```

## Coverage

**Requirements:** No coverage target enforced; testing left to discretion

**View Coverage:**
```bash
# No built-in coverage command
# Would require adding --coverage flag or separate tool
```

**Coverage Status:**
- Core modules have unit tests: auth, llm-client, context-assembler, runtime-observer
- Integration tests for moonshots (autonomous features)
- Some areas untested: dashboard-server, voice-manager (no test files found)

## Test Types

**Unit Tests:**
- Scope: Single function/class behavior in isolation
- Approach: Mock all external dependencies
- Example: `llm-client.test.mjs` tests `BedrockLlmClient.converse()` with mocked fetch
- Pattern: Single responsibility, fast execution (<100ms typical)

**Integration Tests:**
- Scope: Multiple components working together
- Approach: Real file system, network when applicable
- Example: `auth.test.mjs` tests session restore flow with mocked Supabase
- File I/O mocked to avoid side effects; logic flow real

**E2E Tests:**
- Not used in test suite
- Benchmarks in `benchmarks/` directory separate from unit tests

## Common Patterns

**Async Testing:**
```typescript
// Pattern 1: Top-level await in test function
test("async operation", async () => {
  const result = await asyncFunction();
  assert.equal(result, expected);
});

// Pattern 2: Generator/stream testing
test("streaming operation", async () => {
  const gen = client.converseStream(...);
  for await (const event of gen) {
    assert.ok(event.kind);
  }
});
```

**Error Testing:**
```typescript
// Pattern 1: assert.throws for synchronous errors
test("throws on invalid input", () => {
  assert.throws(
    () => mergeNodeOptions("--inspect-brk", [...]),
    /Unsafe NODE_OPTIONS rejected/
  );
});

// Pattern 2: Expect rejection with try/catch
test("rejects on error", async () => {
  let errorThrown = false;
  try {
    await failingFunction();
  } catch (error) {
    errorThrown = true;
    assert.ok(error instanceof Error);
  }
  assert.ok(errorThrown, "expected error to be thrown");
});
```

**Assertion Patterns:**
```typescript
// Exact equality
assert.equal(response.kind, "text");

// Deep equality for objects
assert.deepStrictEqual(user, { email: "test@example.com", id: "user-123" });

// Regex matching
assert.match(requestedUrls[0], /primary-model/);

// Boolean assertions
assert.ok(result.ok, "expected ok to be true");
assert.doesNotMatch(JSON.stringify(result), new RegExp(`x{5000}`));

// Strict inequality
assert.strictEqual(promptLoginCalled, true);
```

**Cleanup Patterns:**
```typescript
// Pattern 1: try/finally for cleanup
test("cleans up resources", async () => {
  const tempDir = await mkdtemp(...);
  const previousValue = process.env.VAR;
  try {
    // Test code
  } finally {
    if (previousValue === undefined) {
      delete process.env.VAR;
    } else {
      process.env.VAR = previousValue;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Pattern 2: afterEach hook
test("suite", async (t) => {
  const original = globalThis.fetch;
  t.afterEach(() => {
    globalThis.fetch = original;
  });

  await t.test("sub-test", () => {
    globalThis.fetch = mock;
  });
});
```

**State Isolation:**
```typescript
// Save and restore to isolate test side effects
test("does not affect global state", async () => {
  const original = process.env.MESH_STATE_DIR;
  process.env.MESH_STATE_DIR = workspaceRoot;
  
  try {
    // Test code
  } finally {
    if (original === undefined) {
      delete process.env.MESH_STATE_DIR;
    } else {
      process.env.MESH_STATE_DIR = original;
    }
  }
});
```

## Test Execution Flow

**Discovery:**
1. `scripts/run-tests.cjs` walks `/Users/edgarbaumann/Desktop/mesh-agent-cli/tests/` directory
2. Collects all `.test.mjs` and `.spec.mjs` files
3. Passes file list to `node --import tsx --test [files]`

**Execution:**
1. TypeScript loaded via tsx (ESM support)
2. Each test file imported and executed in sequence
3. `node:test` runner executes top-level test declarations
4. Subtests await sequentially within parent test
5. Exit code reflects pass/fail status

**Performance:**
- No test timeout specified in framework
- Individual tests typically <100ms
- Integration tests (e.g., runtime-observer) may take 6+ seconds (poll for results)

---

*Testing analysis: 2026-04-27*
