import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// We will test AuthManager behaviors by mocking dependencies
// Instead of actually writing to ~/.config/mesh, we will intercept fs/keytar/supabase calls.

const MOCK_SESSION_DIR = path.join(os.homedir(), ".config", "mesh");
const MOCK_SESSION_FILE = path.join(MOCK_SESSION_DIR, "session.json");

function createUnsignedJwt(payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }),
    "signature"
  ].join(".");
}

test("AuthManager - Unit Tests", async (t) => {
  // Save original globals and modules to restore later
  const originalReadFile = fs.readFile;
  const originalMkdir = fs.mkdir;
  const originalWriteFile = fs.writeFile;
  const originalUnlink = fs.unlink;

  t.afterEach(() => {
    fs.readFile = originalReadFile;
    fs.mkdir = originalMkdir;
    fs.writeFile = originalWriteFile;
    fs.unlink = originalUnlink;
  });

  await t.test("Restores session from file successfully", async () => {
    // Setup Mocks
    fs.readFile = async (filePath) => {
      if (filePath === MOCK_SESSION_FILE) {
        return JSON.stringify({
          access_token: createUnsignedJwt(),
          refresh_token: "mock-refresh-token"
        });
      }
      throw new Error("File not found");
    };
    fs.mkdir = async () => undefined;
    fs.writeFile = async () => undefined;

    // Mock keytar to return empty
    const keytar = await import("keytar");
    const originalGetPassword = keytar.default.getPassword;
    const originalSetPassword = keytar.default.setPassword;
    keytar.default.getPassword = async () => null;
    keytar.default.setPassword = async () => undefined;

    // Mock Supabase by intercepting the client creation (we inject a mock in AuthManager if possible,
    // but since we can't easily mock imports in native Node test runner without loaders, 
    // we'll use a dynamic hack for the test: overriding the internal supabase client)
    
    const { AuthManager } = await import("../src/auth.js");
    const auth = new AuthManager();
    
    // Inject mock supabase
    auth.supabase = {
      auth: {
        setSession: async () => ({
          data: {
            session: { access_token: "new-access", refresh_token: "new-refresh" },
            user: { email: "test@example.com", id: "user-123" }
          },
          error: null
        })
      }
    };

    const user = await auth.ensureAuthenticated();
    assert.deepStrictEqual(user, { email: "test@example.com", id: "user-123" });

    // Restore keytar
    keytar.default.getPassword = originalGetPassword;
    keytar.default.setPassword = originalSetPassword;
  });

  await t.test("Falls back to login if session is corrupt", async () => {
    fs.readFile = async (filePath) => {
      if (filePath === MOCK_SESSION_FILE) {
        return "{ invalid_json: ";
      }
      throw new Error("File not found");
    };

    const { AuthManager } = await import("../src/auth.js");
    const auth = new AuthManager();
    
    // Mock promptLogin so it doesn't actually wait for stdin during tests
    let promptLoginCalled = false;
    auth.promptLogin = async () => {
      promptLoginCalled = true;
      return { email: "prompted@example.com", id: "prompt-123" };
    };

    const user = await auth.ensureAuthenticated();
    
    assert.strictEqual(promptLoginCalled, true);
    assert.deepStrictEqual(user, { email: "prompted@example.com", id: "prompt-123" });
  });

  await t.test("Falls back to login if session shape is invalid (prototype pollution protection)", async () => {
    fs.readFile = async (filePath) => {
      if (filePath === MOCK_SESSION_FILE) {
        // Missing access_token string
        return JSON.stringify({ malicious_key: "true" });
      }
      throw new Error("File not found");
    };

    const { AuthManager } = await import("../src/auth.js");
    const auth = new AuthManager();
    
    let promptLoginCalled = false;
    auth.promptLogin = async () => {
      promptLoginCalled = true;
      return { email: "prompted2@example.com", id: "prompt-456" };
    };

    const user = await auth.ensureAuthenticated();
    
    assert.strictEqual(promptLoginCalled, true);
    assert.deepStrictEqual(user, { email: "prompted2@example.com", id: "prompt-456" });
  });
});
