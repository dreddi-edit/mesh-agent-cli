import { spawn, execFileSync, execSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface VoiceConfig {
  whisperPath: string;
  whisperModel: string;
  piperPath: string;
  piperModel: string;
}

export class VoiceManager {
  private isRecording = false;

  constructor(private config: Partial<VoiceConfig> = {}) {
    this.config.whisperPath = config.whisperPath || "whisper-cpp";
    this.config.piperPath = config.piperPath || "piper";
  }

  private resolveBinary(command: string): string {
    const aliases =
      command === "whisper-cpp"
        ? ["whisper-cpp", "whisper-cli"]
        : [command];

    for (const alias of aliases) {
      const resolved = this.resolveBinaryCandidate(alias);
      if (resolved) {
        return resolved;
      }
    }

    return command;
  }

  private resolveBinaryCandidate(command: string): string | null {
    if (path.isAbsolute(command) || command.includes(path.sep)) {
      return command;
    }

    const candidates = [
      ...((process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command))),
      path.join("/opt/homebrew/bin", command),
      path.join("/usr/local/bin", command)
    ];

    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }

    try {
      return execFileSync("which", [command], { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  }

  private resolveWhisperModel(): string | null {
    const configured = this.config.whisperModel;
    if (configured && fsSync.existsSync(configured)) {
      return configured;
    }
    return configured ?? null;
  }

  hasHomebrew(): boolean {
    return this.resolveBinary("brew") !== "brew";
  }

  async installCoreDependencies(packages: string[] = ["ffmpeg", "whisper-cpp"]): Promise<void> {
    const brewPath = this.resolveBinary("brew");
    if (brewPath === "brew") {
      throw new Error("Homebrew not found. Install Homebrew first from https://brew.sh");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(brewPath, ["install", ...packages], { stdio: "inherit" });
      proc.on("error", (err) => reject(new Error(`brew spawn failed: ${err.message}`)));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`brew install failed with code ${code}`));
      });
    });
  }

  /**
   * Check if necessary binaries are available
   */
  async checkDependencies(): Promise<{ name: string; ok: boolean; hint?: string }[]> {
    const ffmpegPath = this.resolveBinary("ffmpeg");
    const afplayPath = this.resolveBinary("afplay");
    const whisperPath = this.resolveBinary(this.config.whisperPath!);
    const piperPath = this.resolveBinary(this.config.piperPath!);
    const deps = [
      { name: "ffmpeg", cmd: `${ffmpegPath} -version`, hint: "brew install ffmpeg" },
      { name: "afplay", cmd: `${afplayPath} --help`, hint: "Built-in on macOS" },
      { name: "whisper-cpp", cmd: `${whisperPath} --help`, hint: "brew install whisper-cpp" },
      { name: "piper", cmd: `${piperPath} --version`, hint: "Download from github.com/rhasspy/piper" }
    ];

    const results = [];
    for (const dep of deps) {
      try {
        execSync(dep.cmd, { stdio: "ignore" });
        results.push({ name: dep.name, ok: true });
      } catch {
        results.push({ name: dep.name, ok: false, hint: dep.hint });
      }
    }
    return results;
  }

  /**
   * Record audio to a temp file
   */
  async record(durationSeconds: number = 5): Promise<string> {
    const tempFile = path.join(os.tmpdir(), `mesh_voice_${Date.now()}.wav`);
    
    // On Mac, we use avfoundation. ":0" is usually the default microphone.
    const args = [
      "-f", "avfoundation",
      "-i", ":0",
      "-t", durationSeconds.toString(),
      "-ar", "16000",
      "-ac", "1",
      tempFile
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", args);
      proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
      proc.on("close", (code) => {
        if (code === 0) resolve(tempFile);
        else reject(new Error(`ffmpeg failed with code ${code}`));
      });
    });
  }

  /**
   * Transcribe WAV using whisper-cpp
   */
  async transcribe(filePath: string): Promise<string> {
    const whisperModel = this.resolveWhisperModel();
    if (!whisperModel) {
      throw new Error("Whisper model path not configured. Use /setup to set it.");
    }

    const args = [
      "-m", whisperModel,
      "-f", filePath,
      "-nt",
      "-ng",
      "-l", "auto"
    ];
    const whisperPath = this.resolveBinary(this.config.whisperPath!);

    return new Promise((resolve, reject) => {
      let output = "";
      const proc = spawn(whisperPath, args);
      proc.on("error", (err) => reject(new Error(`whisper-cpp spawn failed: ${err.message}`)));
      proc.stdout.on("data", (data) => (output += data.toString()));
      proc.on("close", (code) => {
        if (code === 0) resolve(output.trim());
        else reject(new Error(`whisper-cpp failed with code ${code}`));
      });
    });
  }

  /**
   * Speak text using Piper and afplay
   */
  async speak(text: string): Promise<void> {
    if (!this.config.piperModel) {
      // Fallback to 'say' on Mac if piper is missing
      if (process.platform === "darwin") {
        execSync(`say "${text.replace(/"/g, '\\"')}"`);
        return;
      }
      throw new Error("Piper model path not configured.");
    }

    const tempAudio = path.join(os.tmpdir(), `mesh_speech_${Date.now()}.wav`);
    
    // piper -m model.onnx --output_file out.wav
    const args = [
      "-m", this.config.piperModel,
      "--output_file", tempAudio
    ];
    const piperPath = this.resolveBinary(this.config.piperPath!);

    return new Promise((resolve, reject) => {
      const proc = spawn(piperPath, args);
      proc.on("error", (err) => reject(new Error(`piper spawn failed: ${err.message}`)));
      proc.stdin.write(text);
      proc.stdin.end();
      
      proc.on("close", (code) => {
        if (code === 0) {
          // Play the file
          const play = spawn("afplay", [tempAudio]);
          play.on("error", (err) => reject(new Error(`afplay spawn failed: ${err.message}`)));
          play.on("close", () => {
             fs.unlink(tempAudio).catch(() => {});
             resolve();
          });
        } else {
          reject(new Error(`piper failed with code ${code}`));
        }
      });
    });
  }
}
