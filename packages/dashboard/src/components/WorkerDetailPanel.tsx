import React, { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, Play, Square, Loader2, Clock, CheckCircle, AlertCircle,
  ArrowDown, Wifi, WifiOff, Monitor, Terminal, Info, FileText,
  RefreshCw, Camera, History, ImageOff, Pencil, Trash2, ShieldAlert,
} from "lucide-react";
import type { Account } from "../lib/api";
import { fetchWorkerDetails, startWorker, stopWorker } from "../lib/api";

// ── Utilities ────────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function splitTimestamp(line: string): { ts: string; msg: string } {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)/s);
  return m ? { ts: m[1].slice(11, 19), msg: m[2] } : { ts: "", msg: line };
}

function logColor(msg: string): string {
  if (/error|Error|ERR|Fatal|FATAL/i.test(msg)) return "text-red-400";
  if (/warn|WARN/i.test(msg))   return "text-yellow-400";
  if (/\[Worker\]/i.test(msg))  return "text-blue-400";
  if (/\[Login\]/i.test(msg))   return "text-yellow-300";
  if (/\[Poller\]/i.test(msg))  return "text-green-400";
  if (/\[Captcha\]/i.test(msg)) return "text-purple-400";
  return "text-gray-300";
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const CONSOLE_COLOR: Record<string, string> = {
  error: "text-red-400", warn: "text-yellow-400",
  info: "text-blue-300", log: "text-gray-300", debug: "text-gray-500",
};

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  POLLING: CheckCircle, RUNNING: CheckCircle, AUTHENTICATED: CheckCircle,
  STARTING: Loader2, LOGGING_IN: Loader2, APPLYING: Loader2, CAPTCHA_SOLVING: Loader2,
  WAITING_OTP: Clock, PAUSED: Clock, IDLE: Clock,
  ERROR: AlertCircle, BANNED: AlertCircle,
};

const STATUS_COLOR: Record<string, string> = {
  POLLING: "text-green-400", RUNNING: "text-green-400", AUTHENTICATED: "text-green-400",
  STARTING: "text-blue-400", LOGGING_IN: "text-blue-400", APPLYING: "text-blue-400",
  CAPTCHA_SOLVING: "text-purple-400", WAITING_OTP: "text-yellow-400",
  PAUSED: "text-gray-400", IDLE: "text-gray-500",
  ERROR: "text-red-400", BANNED: "text-red-500",
};

type Tab = "info" | "browser" | "console" | "logs" | "captcha";
type LogLine = { ts: string; msg: string; color: string };
type CaptchaTiles = { attempt: number; question: string; raw: string; edges: string; color: string };
type ConsoleMsg = { level: string; text: string; ts: number };

function parseLogLine(raw: string): LogLine | null {
  const clean = stripAnsi(raw);
  const { ts, msg } = splitTimestamp(clean);
  if (!msg.trim()) return null;
  return { ts, msg, color: logColor(msg) };
}

// ── Log terminal ─────────────────────────────────────────────────────────────
function LogTerminal({
  lines,
  autoScroll,
  setAutoScroll,
  empty,
}: {
  lines: LogLine[];
  autoScroll: boolean;
  setAutoScroll: (v: boolean) => void;
  empty: React.ReactNode;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };

  return (
    <div className="relative h-full">
      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); endRef.current?.scrollIntoView({ behavior: "smooth" }); }}
          className="absolute top-2 right-3 z-10 flex items-center gap-1 text-[10px] bg-gray-800 border border-gray-700 text-blue-400 hover:text-blue-300 px-2 py-1 rounded"
        >
          <ArrowDown className="w-3 h-3" /> Bottom
        </button>
      )}
      <div
        ref={boxRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto bg-black rounded-xl border border-gray-800 p-3 font-mono text-[11px] leading-5"
      >
        {lines.length === 0 ? (
          <div className="text-center mt-12 text-gray-700">{empty}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              {l.ts && <span className="text-gray-700 shrink-0 select-none w-16">{l.ts}</span>}
              <span className={l.color}>{l.msg}</span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
interface Props {
  account: Account;
  liveStatus?: string;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function WorkerDetailPanel({ account, liveStatus, onClose, onEdit, onDelete }: Props) {
  const qc = useQueryClient();
  const status = liveStatus ?? account.status;
  const StatusIcon = STATUS_ICON[status] ?? Clock;
  const statusColor = STATUS_COLOR[status] ?? "text-gray-400";
  const isRunning = ["STARTING","LOGGING_IN","WAITING_OTP","AUTHENTICATED","POLLING","APPLYING","CAPTCHA_SOLVING"].includes(status);

  const [tab, setTab] = useState<Tab>("info");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: details, isLoading } = useQuery({
    queryKey: ["worker-details", account.id],
    queryFn: () => fetchWorkerDetails(account.id),
    refetchInterval: 5000,
  });

  // ── Docker logs ───────────────────────────────────────────────
  const [dockerLines, setDockerLines] = useState<LogLine[]>([]);
  const [captchaAttempts, setCaptchaAttempts] = useState<CaptchaTiles[]>([]);
  const [logsConnected, setLogsConnected] = useState(false);
  const [logsSource, setLogsSource] = useState<"none" | "history" | "live">("none");
  const [logsAutoScroll, setLogsAutoScroll] = useState(true);

  const appendDockerLine = useCallback((raw: string) => {
    const clean = stripAnsi(raw);
    const { msg } = splitTimestamp(clean);
    // Intercept tile images before they hit the text log — store separately for visual rendering
    if (msg.startsWith("[Captcha:tiles] ")) {
      try {
        const data = JSON.parse(msg.slice("[Captcha:tiles] ".length)) as CaptchaTiles;
        setCaptchaAttempts(p => [...p, data]);
      } catch {}
      return;
    }
    const line = parseLogLine(raw);
    if (line) setDockerLines(p => [...p.slice(-499), line]);
  }, []);

  // Load historical logs when stopped/crashed (persisted to Redis on container exit)
  useEffect(() => {
    if (isRunning) return;
    setLogsSource("none");
    fetch(`/api/workers/${account.id}/logs/history`)
      .then(r => r.ok ? r.json() : [])
      .then((rawLines: string[]) => {
        const tiles: CaptchaTiles[] = [];
        const parsed: LogLine[] = [];
        for (const raw of rawLines) {
          const clean = stripAnsi(raw);
          const { msg } = splitTimestamp(clean);
          if (msg.startsWith("[Captcha:tiles] ")) {
            try { tiles.push(JSON.parse(msg.slice("[Captcha:tiles] ".length)) as CaptchaTiles); } catch {}
            continue;
          }
          const line = parseLogLine(raw);
          if (line) parsed.push(line);
        }
        setDockerLines(parsed);
        setCaptchaAttempts(tiles);
        setLogsSource(parsed.length > 0 ? "history" : "none");
      })
      .catch(() => {});
  }, [account.id, isRunning]);

  // Live SSE when running
  useEffect(() => {
    if (!isRunning) return;
    setDockerLines([]);
    setCaptchaAttempts([]);
    setLogsSource("live");
    const es = new EventSource(`/api/workers/${account.id}/logs`);
    es.onopen = () => setLogsConnected(true);
    es.onmessage = (e) => {
      const d = JSON.parse(e.data) as { line?: string; eof?: boolean };
      if (d.line) appendDockerLine(d.line);
      if (d.eof) { setLogsConnected(false); es.close(); }
    };
    es.onerror = () => setLogsConnected(false);
    return () => { setLogsConnected(false); es.close(); };
  }, [account.id, isRunning, appendDockerLine]);

  // ── Browser console ───────────────────────────────────────────
  const [consoleMsgs, setConsoleMsgs] = useState<LogLine[]>([]);
  const [consoleConnected, setConsoleConnected] = useState(false);
  const [consoleAutoScroll, setConsoleAutoScroll] = useState(true);
  const historyLastTsRef = useRef(0);

  const parseConsoleMsg = (m: ConsoleMsg): LogLine => ({
    ts: new Date(m.ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    msg: `[${m.level.toUpperCase()}] ${m.text}`,
    color: CONSOLE_COLOR[m.level] ?? "text-gray-300",
  });

  // Load history once per account — persists across runs in Redis (24h TTL)
  useEffect(() => {
    historyLastTsRef.current = 0;
    fetch(`/api/workers/${account.id}/console/history`)
      .then(r => r.ok ? r.json() : [])
      .then((msgs: ConsoleMsg[]) => {
        if (msgs.length > 0) {
          setConsoleMsgs(msgs.map(parseConsoleMsg));
          historyLastTsRef.current = msgs[msgs.length - 1].ts;
        }
      })
      .catch(() => {});
  }, [account.id]);

  // Live SSE — appends on top of history, deduped by timestamp
  useEffect(() => {
    if (!isRunning) { setConsoleConnected(false); return; }
    const es = new EventSource(`/api/workers/${account.id}/console/stream`);
    es.onopen = () => setConsoleConnected(true);
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data) as ConsoleMsg;
        if (d.ts <= historyLastTsRef.current) return;
        historyLastTsRef.current = d.ts;
        setConsoleMsgs(p => [...p.slice(-499), parseConsoleMsg(d)]);
      } catch {}
    };
    es.onerror = () => setConsoleConnected(false);
    return () => { setConsoleConnected(false); es.close(); };
  }, [account.id, isRunning]);

  // ── Screenshot polling ─────────────────────────────────────────
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotTs, setScreenshotTs] = useState<number>(0);
  const [screenshotLive, setScreenshotLive] = useState(false); // true = fresh from running container

  // Clear last frame only when a new run begins (not on stop/crash — keep last frame)
  const wasRunning = useRef(false);
  useEffect(() => {
    if (isRunning && !wasRunning.current) {
      setScreenshot(null);
      setScreenshotLive(false);
    }
    wasRunning.current = isRunning;
  }, [isRunning]);

  // Poll continuously while on browser tab
  useEffect(() => {
    if (tab !== "browser") return;
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/workers/${account.id}/screenshot`);
        if (!res.ok) { if (alive) setScreenshotLive(false); return; }
        const { image, ts } = await res.json() as { image: string; ts: number };
        if (alive) { setScreenshot(image); setScreenshotTs(ts); setScreenshotLive(isRunning); }
      } catch { if (alive) setScreenshotLive(false); }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [account.id, tab, isRunning]);

  const handleStart = async () => {
    await startWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["worker-details", account.id] });
  };

  const handleStop = async () => {
    await stopWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["worker-details", account.id] });
  };

  const session = details?.sessions[0];
  const containerId = details?.containerId ?? session?.containerId;

  // Captcha text logs — [Captcha:tiles] lines are intercepted before reaching dockerLines
  const captchaLines = dockerLines.filter(l => /\[Captcha/i.test(l.msg));

  const tabs: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }[] = [
    { id: "info",    label: "Info",            icon: Info },
    { id: "browser", label: "Live View",       icon: Monitor },
    { id: "console", label: "Browser Console", icon: Terminal },
    { id: "captcha", label: "Captcha",         icon: ShieldAlert, badge: captchaAttempts.length > 0 ? captchaAttempts.length : undefined },
    { id: "logs",    label: "Logs",            icon: FileText },
  ];

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      <div
        className="fixed right-0 top-0 h-full z-50 flex flex-col bg-gray-900 border-l border-gray-700 shadow-2xl"
        style={{ width: "min(1100px, 92vw)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <StatusIcon className={`w-5 h-5 shrink-0 ${statusColor} ${isRunning && !["POLLING","AUTHENTICATED"].includes(status) ? "animate-spin" : ""}`} />
            <div>
              <p className="font-mono text-sm font-medium">{account.email}</p>
              <p className={`text-xs font-semibold ${statusColor}`}>{status}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {containerId && (
              <span className="text-[10px] font-mono text-gray-600 bg-gray-800 px-2 py-1 rounded">
                {containerId.slice(0, 12)}
              </span>
            )}

            {/* Start / Stop */}
            {isRunning ? (
              <button onClick={handleStop} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900 hover:bg-red-800 text-red-300 text-xs font-medium">
                <Square className="w-3 h-3" /> Stop
              </button>
            ) : (
              <button onClick={handleStart} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-900 hover:bg-green-800 text-green-300 text-xs font-medium">
                <Play className="w-3 h-3" /> Start
              </button>
            )}

            {/* Edit */}
            {onEdit && (
              <button
                onClick={onEdit}
                title="Edit account"
                className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-blue-400"
              >
                <Pencil className="w-4 h-4" />
              </button>
            )}

            {/* Delete — two-step confirm */}
            {onDelete && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete account"
                className="p-1.5 rounded-lg hover:bg-red-950 text-gray-400 hover:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            {onDelete && confirmDelete && (
              <div className="flex items-center gap-1.5 bg-red-950 border border-red-800 rounded-lg px-2 py-1">
                <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span className="text-xs text-red-300">Delete?</span>
                <button
                  onClick={() => { onDelete(); onClose(); }}
                  className="text-xs px-2 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white font-medium"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-xs text-gray-500 hover:text-gray-300"
                >
                  No
                </button>
              </div>
            )}

            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-5 gap-px bg-gray-800 border-b border-gray-800 shrink-0">
          {[
            { label: "Country",   value: account.country },
            { label: "Jobs",      value: account.jobIds.length },
            { label: "Captures",  value: details?.account._count?.captures ?? "—" },
            { label: "Started",   value: session ? timeAgo(session.startedAt) : "—" },
            { label: "Heartbeat", value: session?.lastHeartbeat ? timeAgo(session.lastHeartbeat) : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-gray-900 px-4 py-2.5">
              <p className="text-[10px] uppercase tracking-widest text-gray-600 mb-0.5">{label}</p>
              <p className="text-sm font-mono font-medium">{String(value)}</p>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-gray-800 shrink-0 bg-gray-900">
          {tabs.map(({ id, label, icon: Icon, badge }) => {
            const isActive = tab === id;
            const liveDot =
              (id === "logs" && logsConnected) ||
              (id === "console" && consoleConnected) ||
              (id === "captcha" && logsConnected);
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 px-5 py-2.5 text-xs font-medium border-b-2 transition-colors relative ${
                  isActive ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${id === "captcha" ? "text-purple-400" : ""}`} />
                {label}
                {badge !== undefined && (
                  <span className="ml-0.5 bg-purple-900 text-purple-300 text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                    {badge}
                  </span>
                )}
                {liveDot && <span className="w-1.5 h-1.5 rounded-full bg-green-500 absolute top-2 right-2 animate-pulse" />}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-hidden min-h-0">

          {/* ── INFO ─────────────────────────────────────────────── */}
          {tab === "info" && (
            <div className="h-full overflow-y-auto p-5 space-y-5">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
                </div>
              ) : (
                <>
                  <section>
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Account</h3>
                    <div className="bg-gray-800/60 rounded-xl divide-y divide-gray-800">
                      {[
                        ["Email",      account.email],
                        ["Country",    account.country],
                        ["Proxy",      details?.account.proxy?.label ?? details?.account.proxy?.url ?? "None"],
                        ["Notes",      account.notes ?? "—"],
                        ["Last Login", details?.account.lastLoginAt ? timeAgo(details.account.lastLoginAt) : "Never"],
                      ].map(([k, v]) => (
                        <div key={k} className="flex items-start px-4 py-2.5 gap-4">
                          <span className="text-xs text-gray-500 w-28 shrink-0 mt-0.5">{k}</span>
                          <span className="text-xs text-gray-200 font-mono break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
                      Jobs Monitored ({account.jobIds.length})
                    </h3>
                    <div className="flex flex-wrap gap-1.5">
                      {account.jobIds.map((id) => (
                        <span key={id} className="bg-gray-800 text-gray-300 text-[10px] font-mono px-2 py-1 rounded">
                          #{id.split("-").pop()?.replace(/^0+/, "") ?? ""}
                        </span>
                      ))}
                    </div>
                  </section>

                  {session && (
                    <section>
                      <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Current Session</h3>
                      <div className="bg-gray-800/60 rounded-xl divide-y divide-gray-800">
                        {[
                          ["Container", containerId ? `${containerId.slice(0, 12)}…` : "—"],
                          ["Started",   timeAgo(session.startedAt)],
                          ["Heartbeat", session.lastHeartbeat ? timeAgo(session.lastHeartbeat) : "—"],
                          ["Status",    session.status],
                          ...(session.errorMessage ? [["Error", session.errorMessage]] : []),
                        ].map(([k, v]) => (
                          <div key={k} className="flex items-start px-4 py-2.5 gap-4">
                            <span className="text-xs text-gray-500 w-28 shrink-0 mt-0.5">{k}</span>
                            <span className={`text-xs font-mono break-all ${k === "Error" ? "text-red-400" : "text-gray-200"}`}>{v}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {details && details.recentEvents.length > 0 && (
                    <section>
                      <h3 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">Recent Events</h3>
                      <div className="space-y-1.5">
                        {details.recentEvents.slice(0, 12).map((e) => (
                          <div key={e.id} className="flex items-start gap-3 text-xs font-mono">
                            <span className="text-gray-600 shrink-0 w-14">
                              {new Date(e.createdAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <span className={`shrink-0 w-40 ${e.type === "job:captured" ? "text-green-400" : e.type.includes("crash") ? "text-red-400" : "text-gray-400"}`}>
                              {e.type}
                            </span>
                            <span className="text-gray-600 truncate">
                              {JSON.stringify(e.payload).slice(0, 80)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── BROWSER VIEW ─────────────────────────────────────── */}
          {tab === "browser" && (
            <div className="h-full flex flex-col bg-black">
              <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Camera className="w-3.5 h-3.5" />
                  {screenshotLive ? "Live Browser View" : screenshot ? "Last Browser Frame" : "Browser View"}
                  {screenshotTs > 0 && (
                    <span className="text-gray-600">· {new Date(screenshotTs).toLocaleTimeString("en-CA")}</span>
                  )}
                </div>
                {screenshotLive ? (
                  <span className="flex items-center gap-1 text-[10px] text-green-500">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    Live · 1.5s
                  </span>
                ) : screenshot ? (
                  <span className="flex items-center gap-1 text-[10px] text-yellow-600">
                    <ImageOff className="w-3 h-3" /> Frozen
                  </span>
                ) : null}
              </div>

              <div className="flex-1 relative flex items-center justify-center overflow-auto p-4">
                {screenshot ? (
                  <>
                    <img
                      src={`data:image/jpeg;base64,${screenshot}`}
                      alt="Browser frame"
                      className="max-w-full max-h-full rounded-lg border border-gray-800 shadow-xl object-contain"
                    />
                    {/* Overlay banner when showing a frozen last-frame */}
                    {!screenshotLive && (
                      <div className="absolute top-5 left-5 flex items-center gap-1.5 bg-black/85 text-[11px] text-yellow-400 px-3 py-1.5 rounded-lg border border-yellow-900/60">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        Last frame before container stopped
                        {screenshotTs > 0 && (
                          <span className="text-yellow-700 ml-1">
                            · {new Date(screenshotTs).toLocaleTimeString("en-CA")}
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : !isRunning ? (
                  <div className="text-center text-gray-700">
                    <Monitor className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">Worker not running</p>
                    <p className="text-xs mt-1">Start the worker to see the live browser</p>
                  </div>
                ) : (
                  <div className="text-center text-gray-700">
                    <RefreshCw className="w-8 h-8 mx-auto mb-3 opacity-30 animate-spin" />
                    <p className="text-sm">Waiting for first screenshot…</p>
                    <p className="text-xs mt-1 text-gray-600">Browser still initializing</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── BROWSER CONSOLE ──────────────────────────────────── */}
          {tab === "console" && (
            <div className="h-full flex flex-col p-4 gap-3">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs text-gray-500">
                  Browser JS console
                  {consoleMsgs.length > 0 && ` · ${consoleMsgs.length} messages`}
                </span>
                <span className={`flex items-center gap-1 text-[10px] ${
                  consoleConnected ? "text-green-500"
                  : consoleMsgs.length > 0 ? "text-yellow-600"
                  : "text-gray-700"
                }`}>
                  {isRunning
                    ? consoleConnected
                      ? <><Wifi className="w-3 h-3" /> Live</>
                      : <><WifiOff className="w-3 h-3" /> Connecting…</>
                    : consoleMsgs.length > 0
                      ? <><History className="w-3 h-3" /> Historical</>
                      : "No data"}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <LogTerminal
                  lines={consoleMsgs}
                  autoScroll={consoleAutoScroll}
                  setAutoScroll={setConsoleAutoScroll}
                  empty="No browser console messages"
                />
              </div>
            </div>
          )}

          {/* ── CAPTCHA ──────────────────────────────────────────── */}
          {tab === "captcha" && (
            <div className="h-full flex flex-col p-4 gap-3">
              {/* Header */}
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs text-gray-500 flex items-center gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />
                  Captcha solver
                  {captchaLines.length > 0 && ` · ${captchaLines.length} log lines`}
                  {captchaAttempts.length > 0 && ` · ${captchaAttempts.length} attempt${captchaAttempts.length > 1 ? "s" : ""}`}
                </span>
                <span className={`flex items-center gap-1 text-[10px] ${
                  logsConnected ? "text-green-500" : captchaLines.length > 0 || captchaAttempts.length > 0 ? "text-yellow-600" : "text-gray-700"
                }`}>
                  {isRunning
                    ? logsConnected
                      ? <><Wifi className="w-3 h-3" /> Live</>
                      : <><WifiOff className="w-3 h-3" /> Connecting…</>
                    : captchaLines.length > 0 || captchaAttempts.length > 0
                      ? <><History className="w-3 h-3" /> Saved</>
                      : "No activity"}
                </span>
              </div>

              {/* Captcha tile grids — all attempts accumulated, newest at bottom */}
              {captchaAttempts.length > 0 && (
                <div className="overflow-y-auto space-y-2 max-h-72 shrink-0">
                  {captchaAttempts.map((att, i) => (
                    <div key={i} className="rounded-xl border border-purple-900/40 bg-black/30 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-purple-900/30">
                        <Camera className="w-3 h-3 text-purple-400 shrink-0" />
                        <span className="text-[10px] text-purple-400 font-medium shrink-0">
                          Attempt {att.attempt}
                        </span>
                        {att.question && (
                          <span className="text-[10px] text-purple-600 italic truncate">— "{att.question}"</span>
                        )}
                      </div>
                      <div className="flex gap-1 p-2 bg-black/20">
                        {([["raw", att.raw], ["edges", att.edges], ["color", att.color]] as [string, string][]).map(([label, src]) => (
                          <div key={label} className="flex-1 min-w-0 flex flex-col gap-0.5">
                            <span className="text-[9px] text-center text-gray-500 uppercase tracking-wider">{label}</span>
                            <img
                              src={src}
                              alt={label}
                              className="w-full rounded border border-gray-800 object-contain"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Text logs */}
              <div className="flex-1 min-h-0">
                <LogTerminal
                  lines={captchaLines}
                  autoScroll={logsAutoScroll}
                  setAutoScroll={setLogsAutoScroll}
                  empty={
                    <div className="space-y-1">
                      <ShieldAlert className="w-8 h-8 mx-auto opacity-20 text-purple-400" />
                      <p>{isRunning ? "Waiting for captcha activity…" : "No captcha logs yet"}</p>
                      <p className="text-[10px] text-gray-700 mt-1">Row images and solver steps appear here when a captcha is encountered</p>
                    </div>
                  }
                />
              </div>
            </div>
          )}

          {/* ── DOCKER LOGS ──────────────────────────────────────── */}
          {tab === "logs" && (
            <div className="h-full flex flex-col p-4 gap-3">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-xs text-gray-500">
                  {logsSource === "history" && "Last session logs (saved on container exit)"}
                  {logsSource === "live"    && "Docker container stdout / stderr"}
                  {logsSource === "none"    && "Docker container logs"}
                </span>
                <span className={`flex items-center gap-1 text-[10px] ${
                  logsConnected         ? "text-green-500"
                  : logsSource === "history" ? "text-yellow-600"
                  : "text-gray-600"
                }`}>
                  {logsSource === "live"
                    ? logsConnected
                      ? <><Wifi className="w-3 h-3" /> Live</>
                      : <><WifiOff className="w-3 h-3" /> Disconnected</>
                    : logsSource === "history"
                      ? <><History className="w-3 h-3" /> {dockerLines.length} lines saved</>
                      : "No logs"}
                </span>
              </div>
              <div className="flex-1 min-h-0">
                <LogTerminal
                  lines={dockerLines}
                  autoScroll={logsAutoScroll}
                  setAutoScroll={setLogsAutoScroll}
                  empty={
                    isRunning
                      ? "Waiting for log output…"
                      : "No saved logs — run the worker to capture logs"
                  }
                />
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
