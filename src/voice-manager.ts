import { spawn, execSync } from "node:child_process";
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

  /**
   * Check if necessary binaries are available
   */
  async checkDependencies(): Promise<{ name: string; ok: boolean; hint?: string }[]> {
    const deps = [
      { name: "ffmpeg", cmd: "ffmpeg -version", hint: "brew install ffmpeg" },
      { name: "afplay", cmd: "afplay --help", hint: "Built-in on macOS" },
      { name: "whisper-cpp", cmd: `${this.config.whisperPath} --help`, hint: "brew install whisper-cpp" },
      { name: "piper", cmd: `${this.config.piperPath} --version`, hint: "Download from github.com/rhasspy/piper" }
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
    if (!this.config.whisperModel) {
      throw new Error("Whisper model path not configured. Use /setup to set it.");
    }

    const args = [
      "-m", this.config.whisperModel,
      "-f", filePath,
      "-nt" // No timestamps
    ];

    return new Promise((resolve, reject) => {
      let output = "";
      const proc = spawn(this.config.whisperPath!, args);
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

    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.piperPath!, args);
      proc.stdin.write(text);
      proc.stdin.end();
      
      proc.on("close", (code) => {
        if (code === 0) {
          // Play the file
          spawn("afplay", [tempAudio]).on("close", () => {
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
