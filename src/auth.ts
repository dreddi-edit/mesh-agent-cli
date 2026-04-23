import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { createClient, SupabaseClient, Session } from "@supabase/supabase-js";
import pc from "picocolors";
import keytar from "keytar";
import "dotenv/config";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://msmonxiacxhendxehezw.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zbW9ueGlhY3hoZW5keGVoZXp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NDU3NTMsImV4cCI6MjA5MjUyMTc1M30.K-FQFpcOwtJAIAfn5lTzmrox_6cv_8qqXGxi9IgosB8";

const SESSION_DIR = path.join(os.homedir(), ".config", "mesh");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");
const KEYCHAIN_SERVICE = "mesh-agent-cli";
const KEYCHAIN_ACCOUNT = "refresh-token";

export interface MeshUser {
  email: string;
  id: string;
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
      const stored = JSON.parse(raw) as Session;
      
      // Try to get refresh token from keychain
      const refreshToken = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      
      const { data, error } = await this.supabase.auth.setSession({
        access_token: stored.access_token,
        refresh_token: refreshToken || (stored as any).refresh_token
      });
      
      if (!error && data.session && data.user) {
        this.session = data.session;
        // Persist refreshed tokens
        await this.saveSession(data.session);
        return { email: data.user.email!, id: data.user.id };
      }
    } catch {
      // No session file or invalid — fall through to login
    }

    // 2. Interactive login
    return this.promptLogin();
  }

  private async promptLogin(): Promise<MeshUser> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    
    process.stdout.write(
      [
        "",
        `${pc.cyan(pc.bold("mesh"))}  ${pc.dim("Please sign in to continue.")}`,
        ""
      ].join("\n") + "\n"
    );

    let user: MeshUser | null = null;

    while (!user) {
      const email = (await rl.question(pc.dim("email: "))).trim();
      const password = (await rl.question(pc.dim("password: "))).trim();

      const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });

      if (error || !data.session || !data.user) {
        process.stdout.write(pc.red(`\n  ✗ ${error?.message ?? "Login failed. Please try again."}\n\n`));
        continue;
      }

      this.session = data.session;
      await this.saveSession(data.session);
      user = { email: data.user.email!, id: data.user.id };
    }

    rl.close();
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
    await fs.mkdir(SESSION_DIR, { recursive: true });
    
    // Store refresh token in keychain
    if (session.refresh_token) {
      await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, session.refresh_token);
    }

    // Store only access_token and other non-sensitive info in the file
    const safeSession = { ...session };
    delete (safeSession as any).refresh_token;
    
    await fs.writeFile(SESSION_FILE, JSON.stringify(safeSession), { mode: 0o600 });
  }

  getAccessToken(): string | undefined {
    return this.session?.access_token;
  }
}

