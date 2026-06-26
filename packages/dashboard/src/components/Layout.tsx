import React, { useState, useEffect, useRef } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Users, Briefcase, Globe, Activity, Settings, Bell, Radio, FlaskConical } from "lucide-react";
import { useSocketEvents } from "../lib/socket";
import type { BusEvent } from "../lib/api";

const NAV = [
  { to: "/", label: "Overview",  icon: LayoutDashboard },
  { to: "/accounts", label: "Accounts", icon: Users },
  { to: "/jobs",  label: "Jobs",     icon: Briefcase },
  { to: "/polling", label: "Polling",  icon: Radio },
  { to: "/tests",   label: "Tests",    icon: FlaskConical },
  { to: "/proxies", label: "Proxies",  icon: Globe },
  { to: "/logs",  label: "Logs",     icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

const ALERT_TYPES = new Set([
  "job:captured",
  "job:application_confirmed",
  "worker:crashed",
  "session:expired",
  "account:banned",
  "account:possible_shadow_ban",
  "proxy:failed",
]);

const EVENT_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  "job:captured":              { dot: "bg-green-400",  text: "text-green-400",  label: "Job Captured" },
  "job:application_confirmed": { dot: "bg-green-300",  text: "text-green-300",  label: "Confirmed" },
  "worker:crashed":            { dot: "bg-red-500",    text: "text-red-400",    label: "Worker Crashed" },
  "session:expired":           { dot: "bg-yellow-400", text: "text-yellow-400", label: "Session Expired" },
  "account:banned":            { dot: "bg-red-600",    text: "text-red-500",    label: "Account Banned" },
  "account:possible_shadow_ban":{ dot: "bg-orange-400",text: "text-orange-400", label: "Shadow Ban?" },
  "proxy:failed":              { dot: "bg-orange-500", text: "text-orange-400", label: "Proxy Failed" },
};

function formatPayload(event: BusEvent): string {
  const p = event.payload as Record<string, string | undefined>;
  if (event.type === "job:captured") {
    return `${p.jobTitle ?? "Job"} · ${p.location ?? ""}`;
  }
  if (event.type === "worker:crashed") {
    return p.reason ?? "Unknown error";
  }
  const email = p.email ?? p.accountEmail ?? "";
  return email || JSON.stringify(p).slice(0, 60);
}

function NotificationBell() {
  const allEvents = useSocketEvents(100);
  const alerts = allEvents.filter((e) => ALERT_TYPES.has(e.type));
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);

  const unread = alerts.filter((e) => e.ts > seenAt).length;

  const handleOpen = () => {
    setOpen((v) => !v);
    if (!open) setSeenAt(Date.now());
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={handleOpen}
        className="relative p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        title="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-full top-0 ml-2 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-800">
            <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Notifications</span>
            <button
              onClick={() => setSeenAt(Date.now())}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-gray-800/50">
            {alerts.length === 0 ? (
              <p className="text-gray-600 text-xs text-center py-8">No alerts yet</p>
            ) : (
              alerts.slice(0, 30).map((e, i) => {
                const style = EVENT_STYLES[e.type] ?? { dot: "bg-gray-400", text: "text-gray-400", label: e.type };
                const isNew = e.ts > seenAt;
                return (
                  <div
                    key={`${e.ts}-${i}`}
                    className={`flex items-start gap-2.5 px-3 py-2.5 ${isNew ? "bg-gray-800/60" : ""}`}
                  >
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${style.dot} ${isNew ? "animate-pulse" : "opacity-50"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
                        <span className="text-[10px] text-gray-600 shrink-0">
                          {new Date(e.ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">{formatPayload(e)}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-800 flex items-center justify-between">
          <div>
            <span className="text-lg font-bold text-brand-500">CA-Bot</span>
            <p className="text-xs text-gray-500 mt-0.5">Job Sniper v2</p>
          </div>
          <NotificationBell />
        </div>
        <nav className="flex-1 py-4 space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800/60"
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-gray-800">
          <p className="text-xs text-gray-600">v2.0.0</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-gray-950">
        <Outlet />
      </main>
    </div>
  );
}
