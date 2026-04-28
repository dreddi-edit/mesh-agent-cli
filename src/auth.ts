import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import pkg from "enquirer";
const { prompt } = pkg;
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import pc from "picocolors";
import keytar from "keytar";
import "dotenv/config";

// These are the public Mesh auth endpoints. The anon key is a Supabase public
// client key (not a secret) — it is intentionally committed and relies on
// Row Level Security for data isolation. Override via env vars if self-hosting.
// nosec: public-supabase-anon-key
const SUPABASE_URL = process.env.SUPABASE_URL || "https://msmonxiacxhendxehezw.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || // nosec
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zbW9ueGlhY3hoZW5keGVoZXp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NDU3NTMsImV4cCI6MjA5MjUyMTc1M30.K-FQFpcOwtJAIAfn5lTzmrox_6cv_8qqXGxi9IgosB8";

const SESSION_DIR = path.join(os.homedir(), ".config", "mesh");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");
const KEYCHAIN_SERVICE = "mesh-agent-cli";
const KEYCHAIN_ACCOUNT = "refresh-token";

export interface MeshUser {
  email: string;
  id: string;
}

// Discriminator types for better error handling without thrown errors where possible
export type AuthResult = 
  | { ok: true; user: MeshUser }
  | { ok: false; reason: string };

function isJwtShape(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    // Reject tokens that are already expired
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function isSessionShape(obj: unknown): obj is Omit<Session, "refresh_token"> & { refresh_token?: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "access_token" in obj &&
    typeof (obj as any).access_token === "string" &&
    isJwtShape((obj as any).access_token)
  );
}

export class AuthManager {
  private readonly supabase: SupabaseClient;
  private session: Session | null = null;

  constructor() {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  /** Restore a persisted session, or prompt login if none / expired. */
  async ensureAuthenticated(): Promise<MeshUser> {
    // 1. Try to restore a saved session
    try {
      const raw = await fs.readFile(SESSION_FILE, "utf-8");
      const stored: unknown = JSON.parse(raw);
      
      if (!isSessionShape(stored)) {
        throw new Error("Invalid session shape");
      }
      
      // Try to get refresh token from keychain
      const keychainToken = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const fallbackToken = stored.refresh_token ?? undefined;
      const refreshToken = keychainToken || fallbackToken;
      
      if (stored.access_token) {
        const { data, error } = await this.supabase.auth.setSession({
          access_token: stored.access_token,
          refresh_token: refreshToken || ""
        });
        
        if (!error && data.session && data.user && data.user.email) {
          this.session = data.session;
          // Persist refreshed tokens
          await this.saveSession(data.session);
          return { email: data.user.email, id: data.user.id };
        }
      }
    } catch {
      // No session file or invalid — fall through to login
    }

    // 2. Interactive login
    return this.promptLogin();
  }

  private async promptLogin(): Promise<MeshUser> {
    process.stdout.write(
      [
        "",
        `${pc.cyan(pc.bold("mesh"))}  ${pc.dim("Please sign in to continue.")}`,
        ""
      ].join("\n") + "\n"
    );

    let user: MeshUser | null = null;

    while (!user) {
      const { email, password } = await prompt<{email: string, password: string}>([
        { type: "input", name: "email", message: pc.dim("email: ") },
        { type: "password", name: "password", message: pc.dim("password: ") }
      ]);

      const emailTrimmed = email?.trim() || "";
      const passwordTrimmed = password?.trim() || "";
      
      if (!emailTrimmed || !passwordTrimmed) {
        process.stdout.write(pc.red(`\n  ✗ Email and password are required.\n\n`));
        continue;
      }

      const { data, error } = await this.supabase.auth.signInWithPassword({ 
        email: emailTrimmed, 
        password: passwordTrimmed 
      });

      if (error || !data.session || !data.user || !data.user.email) {
        process.stdout.write(pc.red(`\n  ✗ ${error?.message ?? "Login failed. Please try again."}\n\n`));
        continue;
      }

      this.session = data.session;
      await this.saveSession(data.session);
      user = { email: data.user.email, id: data.user.id };
    }

    process.stdout.write(pc.green(`\n  ✓ Signed in as ${user.email}\n\n`));
    return user;
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
    try {
      await fs.unlink(SESSION_FILE);
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    } catch {
      // Already gone
    }
    process.stdout.write(pc.dim("\nSigned out.\n"));
  }

  private async saveSession(session: Session): Promise<void> {
    // 0o700 is strict: rwx for owner, nothing for group/others
    await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
    
    // Store refresh token in keychain
    if (session.refresh_token) {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, session.refresh_token);
    }

    // Explicitly destructure to omit refresh_token instead of using `any`
    const { refresh_token: _ignored, ...safeSession } = session;
    
    await fs.writeFile(SESSION_FILE, JSON.stringify(safeSession), { mode: 0o600 });
  }

  getAccessToken(): string | undefined {
    return this.session?.access_token;
  }
}

