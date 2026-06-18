import { io, type Socket } from "socket.io-client";
import { useEffect, useRef, useState } from "react";
import type { BusEvent } from "./api";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: "/socket.io", transports: ["websocket"] });
  }
  return socket;
}

export function useSocketEvents(limit = 50): BusEvent[] {
  const [events, setEvents] = useState<BusEvent[]>([]);

  useEffect(() => {
    const s = getSocket();
    const handler = (event: BusEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, limit));
    };
    s.on("event", handler);
    return () => { s.off("event", handler); };
  }, [limit]);

  return events;
}

export function useWorkerStates(): Record<string, string> {
  const [states, setStates] = useState<Record<string, string>>({});

  useEffect(() => {
    const s = getSocket();
    const handler = (event: BusEvent) => {
      if (event.type === "worker:state") {
        const { accountId, state } = event.payload as { accountId: string; state: string };
        setStates((prev) => ({ ...prev, [accountId]: state }));
      }
    };
    s.on("event", handler);
    return () => { s.off("event", handler); };
  }, []);

  return states;
}
