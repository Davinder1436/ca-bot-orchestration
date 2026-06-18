import React, { useState } from "react";
import { useSocketEvents } from "../lib/socket";
import type { BusEvent } from "../lib/api";

const EVENT_COLORS: Record<string, string> = {
  "job:captured": "text-green-400",
  "job:application_confirmed": "text-green-300",
  "worker:started": "text-blue-400",
  "worker:stopped": "text-gray-400",
  "worker:crashed": "text-red-400",
  "worker:state": "text-gray-500",
  "worker:heartbeat": "text-gray-700",
  "session:expired": "text-yellow-400",
  "proxy:failed": "text-orange-400",
  "account:banned": "text-red-500",
  "account:possible_shadow_ban": "text-orange-300",
};

function EventRow({ event }: { event: BusEvent }) {
  const color = EVENT_COLORS[event.type] ?? "text-gray-400";
  const time = new Date(event.ts).toLocaleTimeString("en-CA");
  return (
    <div className="flex items-start gap-3 py-2 border-b border-gray-800/50 font-mono text-xs hover:bg-gray-900/30">
      <span className="text-gray-600 shrink-0 w-20">{time}</span>
      <span className={`shrink-0 w-48 ${color}`}>{event.type}</span>
      <span className="text-gray-500 truncate">
        {event.accountId && <span className="text-gray-400 mr-2">[{event.accountId.slice(0, 8)}]</span>}
        {JSON.stringify(event.payload)}
      </span>
    </div>
  );
}

export function Logs() {
  const events = useSocketEvents(200);
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? events.filter((e) => e.type.includes(filter) || JSON.stringify(e.payload).includes(filter))
    : events;

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Live Event Log</h1>
        <input
          placeholder="Filter events..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm w-56 focus:outline-none focus:border-gray-500"
        />
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-gray-800 bg-gray-900/30 p-4">
        {filtered.length === 0 ? (
          <p className="text-gray-600 text-sm text-center py-8">Waiting for events... (real-time via WebSocket)</p>
        ) : (
          filtered.map((e, i) => <EventRow key={`${e.ts}-${i}`} event={e} />)
        )}
      </div>
    </div>
  );
}
