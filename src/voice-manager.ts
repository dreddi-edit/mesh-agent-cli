import { spawn, execFileSync, execSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_WHISPER_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";

export interface VoiceConfig {
  whisperPath: string;
  whisperModel: string;
  piperPath: string;
  piperModel: string;
  voiceLanguage: string;
  voiceSpeed: number;
  voiceName: string;
}

export interface VoiceTranscriptionResult {
  text: string;
  language: string;
}

export interface SystemVoiceOption {
  name: string;
  locale: string;
  sample: string;
}

const MACOS_SAY_RATE = "260";
const MACOS_VOICE_BY_LANGUAGE: Record<string, string> = {
  de: "Anna",
  en: "Daniel",
  es: "Mónica",
  fr: "Jacques",
  it: "Alice",
  ja: "Kyoko",
  pt: "Luciana"
};

export class VoiceManager {
  private isRecording = false;

  constructor(private config: Partial<VoiceConfig> = {}) {
    this.config.whisperPath = config.whisperPath || "whisper-cpp";
    this.config.piperPath = config.piperPath || "piper";
    this.config.voiceLanguage = config.voiceLanguage || "auto";
    this.config.voiceSpeed = config.voiceSpeed || Number(MACOS_SAY_RATE);
    this.config.voiceName = config.voiceName || "auto";
  }

  updateConfig(config: Partial<VoiceConfig>): void {
    this.config = {
      ...this.config,
      ...config
    };
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
    return null;
  }

  private resolvePiperModel(): string | null {
    const configured = this.config.piperModel;
    if (configured && fsSync.existsSync(configured)) {
      return configured;
    }
    return null;
  }

  hasHomebrew(): boolean {
    return this.resolveBinary("brew") !== "brew";
  }

  getWhisperModelPath(): string | undefined {
    return this.config.whisperModel;
  }

  hasWhisperModel(): boolean {
    return Boolean(this.resolveWhisperModel());
  }

  listSystemVoices(): SystemVoiceOption[] {
    if (process.platform !== "darwin") {
      return [];
    }

    try {
      const raw = execFileSync("say", ["-v", "?"], { encoding: "utf8" });
      return raw
        .split("\n")
        .map((line) => line.match(/^(.*?)\s+([a-z]{2}(?:_[A-Z0-9]+)?)\s+#\s*(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => ({
          name: match[1].trim(),
          locale: match[2].trim(),
          sample: match[3].trim()
        }));
    } catch {
      return [];
    }
  }

  async installWhisperModel(targetPath = this.config.whisperModel): Promise<string> {
    if (!targetPath) {
      throw new Error("Whisper model path not configured.");
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.download`;

    try {
      const response = await fetch(DEFAULT_WHISPER_MODEL_URL);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} while downloading Whisper model`);
      }

      await pipeline(
        Readable.fromWeb(response.body as globalThis.ReadableStream),
        fsSync.createWriteStream(tempPath)
      );
      await fs.rename(tempPath, targetPath);
      return targetPath;
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
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
  async transcribe(filePath: string): Promise<VoiceTranscriptionResult> {
    const whisperModel = this.resolveWhisperModel();
    if (!whisperModel) {
      throw new Error(`Whisper model not found at ${this.config.whisperModel}.`);
    }
    const configuredLanguage = this.normalizeLanguage(this.config.voiceLanguage);
    const whisperLanguage = configuredLanguage === "auto" ? "auto" : configuredLanguage;

    const args = [
      "-m", whisperModel,
      "-f", filePath,
      "-nt",
      "-ng",
      "-l", whisperLanguage
    ];
    const whisperPath = this.resolveBinary(this.config.whisperPath!);

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      const proc = spawn(whisperPath, args);
      proc.on("error", (err) => reject(new Error(`whisper-cpp spawn failed: ${err.message}`)));
      proc.stdout.on("data", (data) => (output += data.toString()));
      proc.stderr.on("data", (data) => (errorOutput += data.toString()));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({
            text: output.trim(),
            language: whisperLanguage === "auto" ? this.extractDetectedLanguage(errorOutput) : whisperLanguage
          });
        } else {
          const detail = errorOutput.trim().split("\n").slice(-3).join(" | ");
          reject(
            new Error(
              `whisper-cpp failed with code ${code} (model: ${whisperModel})${detail ? `: ${detail}` : ""}`
            )
          );
        }
      });
    });
  }

  private prepareSpeechText(text: string): string {
    return text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/```[\s\S]*?```/g, " Code ausgelassen. ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractDetectedLanguage(stderr: string): string {
    const match = stderr.match(/auto-detected language:\s*([a-z]{2,3}(?:[-_][A-Z]{2})?)/i);
    return match?.[1]?.toLowerCase() || "en";
  }

  private normalizeLanguage(language?: string): string {
    return String(language || "en")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
  }

  private resolveSayVoice(language?: string): string | undefined {
    const configuredVoice = this.config.voiceName?.trim();
    if (configuredVoice && configuredVoice !== "auto") {
      return configuredVoice;
    }
    const normalized = this.normalizeLanguage(language);
    const baseLanguage = normalized.split("-")[0];
    return MACOS_VOICE_BY_LANGUAGE[normalized] || MACOS_VOICE_BY_LANGUAGE[baseLanguage];
  }

  private speakWithMacOsSay(speechText: string, language?: string): void {
    const voice = this.resolveSayVoice(language);
    const speed = String(this.config.voiceSpeed || Number(MACOS_SAY_RATE));
    const args = voice
      ? ["-v", voice, "-r", speed, speechText]
      : ["-r", speed, speechText];
    execFileSync("say", args, { stdio: "ignore" });
  }

  /**
   * Speak text using Piper and afplay
   */
  async speak(text: string, language = "en"): Promise<void> {
    const speechText = this.prepareSpeechText(text);
    if (!speechText) {
      return;
    }

    const configuredLanguage = this.normalizeLanguage(this.config.voiceLanguage);
    const normalizedLanguage = configuredLanguage === "auto"
      ? this.normalizeLanguage(language)
      : configuredLanguage;
    const piperModel = this.resolvePiperModel();
    const shouldUsePiper = process.platform !== "darwin" && Boolean(piperModel) && normalizedLanguage.startsWith("en");

    if (!shouldUsePiper) {
      if (process.platform === "darwin") {
        this.speakWithMacOsSay(speechText, normalizedLanguage);
        return;
      }
      if (!piperModel) {
        throw new Error("Piper model path not configured.");
      }
    }

    const resolvedPiperModel = piperModel!;

    const tempAudio = path.join(os.tmpdir(), `mesh_speech_${Date.now()}.wav`);
    
    // piper -m model.onnx --output_file out.wav
    const args = [
      "-m", resolvedPiperModel,
      "--output_file", tempAudio
    ];
    const piperPath = this.resolveBinary(this.config.piperPath!);

    return new Promise((resolve, reject) => {
      const proc = spawn(piperPath, args);
      proc.on("error", (err) => reject(new Error(`piper spawn failed: ${err.message}`)));
      proc.stdin.write(speechText);
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
