import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionStatus, DashboardActionName, DashboardServerMessage, DashboardState } from "./types";

const TOKEN_KEY = "meshDashboardToken";

function readDashboardToken(): string {
  let token = sessionStorage.getItem("meshDashboardToken") || "";
  try {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const hashToken = hash.get("token");
    if (hashToken && /^[a-f0-9]{64}$/i.test(hashToken)) {
      token = hashToken;
      sessionStorage.setItem(TOKEN_KEY, hashToken);
      history.replaceState(null, "", location.pathname + location.search);
    }
  } catch {
    return token;
  }
  return token;
}

function wsUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export function useDashboardSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disposedRef = useRef(false);
  const [state, setState] = useState<DashboardState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  const connect = useCallback(() => {
    disposedRef.current = false;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const token = readDashboardToken();
    if (!token) {
      setStatus("error");
      setLastError("Dashboard token missing. Reopen with /dashboard.");
      return;
    }

    const socket = new WebSocket(wsUrl());
    socketRef.current = socket;
    setStatus(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "auth", token }));
    });

    socket.addEventListener("message", (event) => {
      let message: DashboardServerMessage;
      try {
        message = JSON.parse(String(event.data)) as DashboardServerMessage;
      } catch {
        setLastError("Invalid dashboard socket payload.");
        return;
      }
      if (message.type === "auth.ok") {
        reconnectAttemptRef.current = 0;
        setServerVersion(message.version);
        setStatus("live");
        setLastError(null);
        return;
      }
      if (message.type === "state.snapshot") {
        setState(message.state);
        setStatus("live");
        return;
      }
      if (message.type === "error") {
        setLastError(message.error);
        return;
      }
    });

    socket.addEventListener("close", () => {
      if (socketRef.current !== socket || disposedRef.current) return;
      setStatus("reconnecting");
      const delay = Math.min(10_000, 700 + reconnectAttemptRef.current * 900);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    });

    socket.addEventListener("error", () => {
      setStatus("error");
      setLastError("WebSocket connection failed.");
    });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  const runAction = useCallback((action: DashboardActionName) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setLastError("Dashboard socket is not connected.");
      return;
    }
    socket.send(JSON.stringify({ type: "action.run", action }));
  }, []);

  const requestState = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "state.request" }));
    }
  }, []);

  return { state, status, lastError, serverVersion, runAction, requestState };
}
