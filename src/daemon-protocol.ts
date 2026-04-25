import os from "node:os";
import path from "node:path";

export const DAEMON_DIR = path.join(os.homedir(), ".mesh");
export const DAEMON_SOCKET_PATH = path.join(DAEMON_DIR, "daemon.sock");
export const DAEMON_PID_PATH = path.join(DAEMON_DIR, "daemon.pid");
export const DAEMON_STATE_PATH = path.join(DAEMON_DIR, "daemon-state.json");

export type DaemonAction = "status" | "digest" | "stop" | "ping";

export interface DaemonRequest {
  action: DaemonAction;
}

export interface DaemonResponse {
  ok: boolean;
  action: DaemonAction;
  message?: string;
  state?: Record<string, unknown>;
  digest?: string;
}
