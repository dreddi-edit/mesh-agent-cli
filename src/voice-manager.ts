import { spawn, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const WHISPER_MODEL_CATALOG = {
  base: {
    name: "base",
    filename: "ggml-base.bin",
    sizeLabel: "~141 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
  },
  small: {
    name: "small",
    filename: "ggml-small.bin",
    sizeLabel: "~466 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
  },
  medium: {
    name: "medium",
    filename: "ggml-medium.bin",
    sizeLabel: "~1.5 GB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
  }
} as const;
const DEFAULT_WHISPER_MODEL_NAME = "small";

export interface VoiceConfig {
  whisperPath: string;
  whisperModel: string;
  piperPath: string;
  piperModel: string;
  voiceLanguage: string;
  voiceSpeed: number;
  voiceName: string;
  voiceInput: string;
  transcriptionModel: string;
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

export interface AudioInputOption {
  id: string;
  name: string;
}

export interface WhisperModelOption {
  name: string;
  filename: string;
  sizeLabel: string;
  url: string;
}

export interface VoiceDependencyStatus {
  name: string;
  ok: boolean;
  hint?: string;
  required: boolean;
}

interface InstallCoreDependenciesOptions {
  quiet?: boolean;
}

const AUDIO_SAMPLE_RATE = "16000";
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
    this.config.voiceInput = config.voiceInput || "default";
    this.config.transcriptionModel = this.normalizeTranscriptionModel(config.transcriptionModel);
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
      path.join("/usr/local/bin", command),
      path.join("/usr/bin", command),
      path.join("/bin", command)
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

  getWhisperModelInfo(): WhisperModelOption {
    return this.getWhisperModelInfoFor(this.config.transcriptionModel);
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

  listAudioInputDevices(): AudioInputOption[] {
    if (process.platform !== "darwin") {
      return [];
    }

    let raw = "";
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const ffmpegError = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      raw = `${ffmpegError.stdout?.toString?.() ?? ""}\n${ffmpegError.stderr?.toString?.() ?? ""}`;
    }

    const devices = new Map<string, AudioInputOption>();
    let inAudioSection = false;

    for (const line of raw.split(/\r?\n/)) {
      if (line.includes("AVFoundation audio devices")) {
        inAudioSection = true;
        continue;
      }
      if (line.includes("AVFoundation video devices")) {
        inAudioSection = false;
        continue;
      }
      if (!inAudioSection) {
        continue;
      }

      const match = line.match(/\[(\d+)\]\s+(.+)$/);
      if (!match) {
        continue;
      }

      const [, id, name] = match;
      if (!devices.has(id)) {
        devices.set(id, { id, name: name.trim() });
      }
    }

    return Array.from(devices.values());
  }

  async installWhisperModel(
    targetPath = this.config.whisperModel,
    transcriptionModel = this.config.transcriptionModel
  ): Promise<string> {
    if (!targetPath) {
      throw new Error("Whisper model path not configured.");
    }
    const modelInfo = this.getWhisperModelInfoFor(transcriptionModel);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.download`;

    try {
      const response = await fetch(modelInfo.url);
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} while downloading Whisper ${modelInfo.name} model`);
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

  async installCoreDependencies(
    packages: string[] = ["ffmpeg", "whisper-cpp"],
    options: InstallCoreDependenciesOptions = {}
  ): Promise<void> {
    const brewPath = this.resolveBinary("brew");
    if (brewPath === "brew") {
      throw new Error("Homebrew not found. Install Homebrew first from https://brew.sh");
    }

    return new Promise((resolve, reject) => {
      const quiet = options.quiet !== false;
      let brewOutput = "";
      const proc = spawn(brewPath, ["install", ...packages], {
        stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
        env: {
          ...process.env,
          HOMEBREW_NO_ENV_HINTS: "1"
        }
      });
      if (quiet) {
        const appendOutput = (chunk: Buffer) => {
          brewOutput += chunk.toString();
          if (brewOutput.length > 24_000) {
            brewOutput = brewOutput.slice(-24_000);
          }
        };
        proc.stdout?.on("data", appendOutput);
        proc.stderr?.on("data", appendOutput);
      }
      proc.on("error", (err) => reject(new Error(`brew spawn failed: ${err.message}`)));
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else {
          const detail = brewOutput.trim().split(/\r?\n/).slice(-18).join("\n");
          reject(new Error(`brew install failed with code ${code}${detail ? `\n${detail}` : ""}`));
        }
      });
    });
  }

  /**
   * Check if necessary binaries are available
   */
  async checkDependencies(): Promise<VoiceDependencyStatus[]> {
    const ffmpegPath = this.resolveBinary("ffmpeg");
    const whisperPath = this.resolveBinary(this.config.whisperPath!);
    const piperPath = this.resolveBinary(this.config.piperPath!);
    const deps = [
      { name: "ffmpeg", command: ffmpegPath, args: ["-version"], hint: "brew install ffmpeg", required: true },
      { name: "whisper-cpp", command: whisperPath, args: ["--help"], hint: "brew install whisper-cpp", required: true }
    ];

    if (process.platform === "darwin") {
      deps.push({
        name: "macOS say",
        command: this.resolveBinary("say"),
        args: ["-v", "?"],
        hint: "Built into macOS",
        required: false
      });
    } else {
      deps.push({
        name: "piper",
        command: piperPath,
        args: ["--version"],
        hint: "Download from github.com/rhasspy/piper",
        required: false
      });
    }

    const results: VoiceDependencyStatus[] = [];
    for (const dep of deps) {
      try {
        execFileSync(dep.command, dep.args, { stdio: "ignore" });
        results.push({ name: dep.name, ok: true, required: dep.required });
      } catch {
        results.push({ name: dep.name, ok: false, hint: dep.hint, required: dep.required });
      }
    }
    return results;
  }

  /**
   * Record audio to a temp file
   */
  async record(durationSeconds: number = 5): Promise<string> {
    const tempFile = path.join(os.tmpdir(), `mesh_voice_${Date.now()}.wav`);
    const ffmpegPath = this.resolveBinary("ffmpeg");
    const inputId = this.resolveAudioInputId();

    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "avfoundation",
      "-i", `:${inputId}`,
      "-t", durationSeconds.toString(),
      "-ar", AUDIO_SAMPLE_RATE,
      "-ac", "1",
      "-c:a", "pcm_s16le",
      "-af", "volume=1.8",
      "-y",
      tempFile
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
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
      "-sns",
      "-l", whisperLanguage
    ];
    const whisperPath = this.resolveBinary(this.config.whisperPath!);
    const startTime = performance.now();

    return new Promise((resolve, reject) => {
      let output = "";
      let errorOutput = "";
      const proc = spawn(whisperPath, args);
      proc.on("error", (err) => reject(new Error(`whisper-cpp spawn failed: ${err.message}`)));
      proc.stdout.on("data", (data) => (output += data.toString()));
      proc.stderr.on("data", (data) => (errorOutput += data.toString()));
      proc.on("close", (code) => {
        const elapsedMs = (performance.now() - startTime).toFixed(2);
        if (code === 0) {
          console.debug(`[Mesh:Voice] Transcribed audio in ${elapsedMs}ms`);
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

  private normalizeTranscriptionModel(model?: string): string {
    const normalized = String(model || DEFAULT_WHISPER_MODEL_NAME).trim().toLowerCase();
    if (normalized in WHISPER_MODEL_CATALOG) {
      return normalized;
    }
    return DEFAULT_WHISPER_MODEL_NAME;
  }

  private getWhisperModelInfoFor(model?: string): WhisperModelOption {
    const spec =
      WHISPER_MODEL_CATALOG[this.normalizeTranscriptionModel(model) as keyof typeof WHISPER_MODEL_CATALOG] ??
      WHISPER_MODEL_CATALOG[DEFAULT_WHISPER_MODEL_NAME];
    return { ...spec };
  }

  private resolveAudioInputId(): string {
    const configured = String(this.config.voiceInput || "default").trim();
    if (!configured || configured === "default") {
      return "0";
    }
    return configured;
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

    const startTime = performance.now();
    const configuredLanguage = this.normalizeLanguage(this.config.voiceLanguage);
    const normalizedLanguage = configuredLanguage === "auto"
      ? this.normalizeLanguage(language)
      : configuredLanguage;
    const piperModel = this.resolvePiperModel();
    const shouldUsePiper = process.platform !== "darwin" && Boolean(piperModel) && normalizedLanguage.startsWith("en");

    if (!shouldUsePiper) {
      if (process.platform === "darwin") {
        this.speakWithMacOsSay(speechText, normalizedLanguage);
        const elapsedMs = (performance.now() - startTime).toFixed(2);
        console.debug(`[Mesh:Voice] macOS TTS completed in ${elapsedMs}ms`);
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
          const piperElapsed = (performance.now() - startTime).toFixed(2);
          console.debug(`[Mesh:Voice] Piper generated audio in ${piperElapsed}ms`);

          // Play the file with cross-platform detection
          let playerCmd = "aplay";
          let playerArgs = [tempAudio];

          if (process.platform === "win32") {
            playerCmd = "powershell";
            playerArgs = ["-c", `(New-Object Media.SoundPlayer '${tempAudio}').PlaySync()`];
          } else if (process.platform === "darwin") {
            playerCmd = "afplay";
          }

          const play = spawn(playerCmd, playerArgs);
          play.on("error", (err) => reject(new Error(`${playerCmd} spawn failed: ${err.message}`)));
          play.on("close", () => {
             const totalElapsed = (performance.now() - startTime).toFixed(2);
             console.debug(`[Mesh:Voice] Total TTS + playback completed in ${totalElapsed}ms`);
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
