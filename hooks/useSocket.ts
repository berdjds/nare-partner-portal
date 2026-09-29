"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export interface WhatsAppState {
  state?: string;
  qrSvg?: string | null;
  info?: string;
  // W1 sock-auth: non-admin inbox users only ever receive availability as
  // { connected } — never the raw connection state, info or the pairing QR.
  connected?: boolean;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [whatsAppState, setWhatsAppState] = useState<WhatsAppState | null>(null);
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
    socket.on("whatsapp_state", (data) => setWhatsAppState(data));
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

  return { socket: socketRef.current, connected, unauthorized, whatsAppState, lastEvent, disconnectSocket };
}
