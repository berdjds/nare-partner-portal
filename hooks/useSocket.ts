"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export interface WhatsAppState {
  // W3: every server-side emit is account-scoped; pre-W3 payloads (or a
  // single-account server) may omit it and are treated as the default
  // Marhaba account.
  accountKey?: string;
  state?: string;
  qrSvg?: string | null;
  info?: string;
  // W1 sock-auth: non-admin inbox users only ever receive availability as
  // { connected } — never the raw connection state, info or the pairing QR.
  connected?: boolean;
}

// The pre-W3 single account; payloads without an accountKey are Marhaba.
export const DEFAULT_ACCOUNT_KEY = "marhaba";

/**
 * W3: which account state the UI should show. The socket is the live channel
 * and wins once it has delivered a state for the account, but before the
 * first event arrives the state returned by the HTTP status call is the only
 * one the server has reported — show it instead of "initializing".
 */
export function resolveWhatsAppDisplayState(
  socketState: WhatsAppState | null | undefined,
  httpState: WhatsAppState | null | undefined
): WhatsAppState | null {
  return socketState ?? httpState ?? null;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [whatsAppStates, setWhatsAppStates] = useState<Record<string, WhatsAppState>>({});
  const [lastEvent, setLastEvent] = useState<{ type: string; payload: any } | null>(null);

  useEffect(() => {
    const socket = io({
      path: "/api/socket",
      // WebSocket first: the server only accepts handshakes from allowed
      // origins, and browsers always send the Origin header on WebSocket
      // connections (same-origin GET polling requests may omit it).
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (err) => {
      // The server refuses handshakes with a missing/forged/expired session
      // or a disallowed origin as "unauthorized". Retrying cannot fix that,
      // so stop reconnecting and surface the state instead.
      if (err.message === "unauthorized") {
        setUnauthorized(true);
        socket.disconnect();
      }
    });
    socket.on("whatsapp_state", (data: WhatsAppState) => {
      const key = data?.accountKey || DEFAULT_ACCOUNT_KEY;
      setWhatsAppStates((prev) => ({ ...prev, [key]: { ...data, accountKey: key } }));
    });
    socket.on("message", (data) => setLastEvent({ type: "message", payload: data }));
    socket.on("chat_update", (data) => setLastEvent({ type: "chat_update", payload: data }));

    return () => {
      socket.disconnect();
    };
  }, []);

  // Drop the connection on sign-out: the server also revalidates/deactivates
  // sockets, but disconnecting client-side guarantees the session cookie is
  // never used on the socket channel after logout.
  const disconnectSocket = useCallback(() => {
    socketRef.current?.disconnect();
  }, []);

  // Backward-compatible single-account view: the Marhaba entry of the
  // per-account map (pre-W3 consumers read `whatsAppState` directly).
  const whatsAppState = whatsAppStates[DEFAULT_ACCOUNT_KEY] ?? null;

  return { socket: socketRef.current, connected, unauthorized, whatsAppState, whatsAppStates, lastEvent, disconnectSocket };
}
