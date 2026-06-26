import React, { useEffect, useRef, useState } from "react";
import {
  FlaskConical, Play, CheckCircle, AlertTriangle, XCircle, Wifi, WifiOff, ChevronDown,
} from "lucide-react";
import { getSocket } from "../lib/socket";
import { api } from "../lib/api";
import type { Account, BusEvent } from "../lib/api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TestLog {
  testId: string;
  message: string;
  level: "info" | "warn" | "success" | "error";
  timestamp: number;
}

interface RpmResult {
  rpm: number;
  sent: number;
  success: number;
  throttled: number;
  errors: number;
  avgLatencyMs: number;
}

interface PhaseResult {
  phase: string;
  results: RpmResult[];
  maxSafeRpm: number;
}

const LOG_LEVEL_STYLES = {
  info:    "text-gray-400",
  warn:    "text-amber-400",
  success: "text-emerald-400",
  error:   "text-red-400",
};

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function RpmRow({ result }: { result: RpmResult }) {
  const total = result.sent || 1;
  const throttleRate = result.throttled / total;
  const isSafe = result.sent > 0 && throttleRate <= 0.5;

  return (
    <tr className={`border-b border-gray-800/40 text-xs ${throttleRate > 0.5 ? "bg-red-950/10" : ""}`}>
      <td className="py-2 px-3 font-mono text-gray-300">{result.rpm}</td>
      <td className="py-2 px-3">
        <div className="flex items-center gap-1.5">
          <div className="h-2 rounded-sm bg-emerald-500" style={{ width: `${Math.round((result.success / total) * 80)}px` }} />
          <span className="text-gray-400">{result.success}/{result.sent}</span>
        </div>
      </td>
      <td className={`py-2 px-3 font-medium ${result.throttled > 0 ? "text-amber-400" : "text-gray-700"}`}>
        {result.throttled > 0 ? result.throttled : "—"}
      </td>
      <td className={`py-2 px-3 font-medium ${result.errors > 0 ? "text-red-400" : "text-gray-700"}`}>
        {result.errors > 0 ? result.errors : "—"}
      </td>
      <td className="py-2 px-3 text-gray-500">{result.avgLatencyMs > 0 ? `${result.avgLatencyMs}ms` : "—"}</td>
      <td className="py-2 px-3">
        {isSafe
          ? <span className="text-emerald-400 text-[10px] font-semibold">SAFE</span>
          : <span className="text-red-400 text-[10px] font-semibold">THROTTLED</span>
        }
      </td>
    </tr>
  );
}

function PhaseTable({ result }: { result: PhaseResult }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-800/30 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-blue-400">Worker Browser (with session cookies)</span>
          {result.maxSafeRpm > 0
            ? <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800/50 rounded text-[10px] font-bold">
                Max safe: {result.maxSafeRpm} RPM
              </span>
            : <span className="px-2 py-0.5 bg-red-900/40 text-red-400 border border-red-800/50 rounded text-[10px] font-bold">
                All throttled
              </span>
          }
        </div>
        <ChevronDown className={`w-4 h-4 text-gray-600 transition-transform ${collapsed ? "" : "rotate-180"}`} />
      </button>

      {!collapsed && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-950/40">
                {["RPM", "Success", "Throttled", "Errors", "Avg Latency", "Status"].map(h => (
                  <th key={h} className="py-2 px-3 text-left text-[10px] text-gray-600 uppercase tracking-wide font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.results.map(r => <RpmRow key={r.rpm} result={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Tests() {
  const [accounts, setAccounts]         = useState<Account[]>([]);
  const [runningIds, setRunningIds]     = useState<string[]>([]);
  const [selectedAccountId, setAccount] = useState("");
  const [jobId, setJobId]               = useState("");

  const [testId, setTestId]             = useState<string | null>(null);
  const [running, setRunning]           = useState(false);
  const [logs, setLogs]                 = useState<TestLog[]>([]);
  const [phaseResults, setPhaseResults] = useState<PhaseResult[]>([]);
  const [connected, setConnected]       = useState(false);
  const [startError, setStartError]     = useState("");
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load accounts + running workers
  useEffect(() => {
    Promise.all([
      api.get<Account[]>("/accounts"),
      api.get<{ running: string[] }>("/workers"),
    ]).then(([accsRes, workersRes]) => {
      setAccounts(accsRes.data);
      setRunningIds(workersRes.data.running);
      // Pre-select first running account
      const first = accsRes.data.find(a => workersRes.data.running.includes(a.id));
      if (first) {
        setAccount(first.id);
        if (first.jobIds?.length) setJobId(first.jobIds[0]);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const acc = accounts.find(a => a.id === selectedAccountId);
    if (acc?.jobIds?.length) setJobId(acc.jobIds[0]);
  }, [selectedAccountId, accounts]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Socket events
  useEffect(() => {
    const socket = getSocket();
    setConnected(socket.connected);
    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    const onEvent = (event: BusEvent) => {
      const type = event.type;
      const p = event.payload as Record<string, unknown>;

      if (type === "test:log") {
        const entry = p as unknown as TestLog;
        if (!testId || entry.testId === testId) {
          setLogs(prev => [...prev, entry].slice(-500));
        }
      }

      if (type === "test:rpmResult" && (!testId || p.testId === testId)) {
        const { phase, ...result } = p as unknown as { phase: string } & RpmResult;
        setPhaseResults(prev => {
          const idx = prev.findIndex(r => r.phase === phase);
          const existing = prev[idx] ?? { phase, results: [], maxSafeRpm: 0 };
          const rIdx = existing.results.findIndex(r => r.rpm === result.rpm);
          const newResults = rIdx >= 0
            ? existing.results.map((r, i) => i === rIdx ? result : r)
            : [...existing.results, result].sort((a, b) => a.rpm - b.rpm);
          const safe = newResults.filter(r => r.sent > 0 && r.throttled / r.sent <= 0.5);
          const maxSafeRpm = safe.length > 0 ? safe[safe.length - 1].rpm : 0;
          const updated: PhaseResult = { ...existing, results: newResults, maxSafeRpm };
          return idx >= 0 ? prev.map((r, i) => i === idx ? updated : r) : [...prev, updated];
        });
      }

      if ((type === "test:complete" || type === "test:cancelled") && (!testId || p.testId === testId)) {
        setRunning(false);
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("event", onEvent);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("event", onEvent);
    };
  }, [testId]);

  const startTest = async () => {
    if (!selectedAccountId) { setStartError("Select an account with a running worker"); return; }
    if (!jobId.trim()) { setStartError("Job ID is required"); return; }
    if (!runningIds.includes(selectedAccountId)) { setStartError("This account's worker is not running — start it first"); return; }
    setStartError("");
    setLogs([]);
    setPhaseResults([]);
    setRunning(true);

    try {
      const resp = await api.post<{ testId: string }>("/tests/rate-limit/start", {
        accountId: selectedAccountId,
        jobId: jobId.trim(),
      });
      setTestId(resp.data.testId);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? "Failed to start test";
      setStartError(msg);
      setRunning(false);
    }
  };

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const isRunning = selectedAccountId ? runningIds.includes(selectedAccountId) : false;

  return (
    <div className="p-6 space-y-6 min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-purple-400" />
            Rate Limit Tests
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Escalating RPM tests run inside the worker's authenticated browser — same code path as real polling
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {connected
            ? <><Wifi className="w-3.5 h-3.5 text-emerald-500" /><span className="text-emerald-500">Live</span></>
            : <><WifiOff className="w-3.5 h-3.5 text-red-500" /><span className="text-red-500">Disconnected</span></>
          }
        </div>
      </div>

      {/* How it works note */}
      <div className="bg-blue-950/30 border border-blue-900/50 rounded-xl px-4 py-3 text-xs text-blue-300 leading-relaxed">
        <strong>Why browser-based:</strong> Amazon's hiring API requires session cookies (not just the JWT token).
        Bare HTTP requests always return 403. Tests run inside the worker's Playwright browser via{" "}
        <code className="font-mono text-blue-200">fetch(..., &#123; credentials: 'include' &#125;)</code> — the
        same mechanism the old Chrome extension used (<code className="font-mono text-blue-200">pageFetch</code>).
        Results reflect actual limits for this account/IP.
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left — Config + Live log */}
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300">Test Configuration</h2>

            {/* Account selector */}
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Account (must have running worker)</label>
              <select
                value={selectedAccountId}
                onChange={e => setAccount(e.target.value)}
                disabled={running}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600 disabled:opacity-50"
              >
                <option value="">— Select account —</option>
                {accounts.map(a => {
                  const workerRunning = runningIds.includes(a.id);
                  return (
                    <option key={a.id} value={a.id}>
                      {workerRunning ? "▶ " : "⏹ "}{a.email} ({a.country})
                    </option>
                  );
                })}
              </select>
              {selectedAccount && (
                <p className={`text-[11px] mt-1 ${isRunning ? "text-emerald-500" : "text-amber-500"}`}>
                  {isRunning ? "✓ Worker running — test can start" : "⚠ Worker not running — start it first"}
                </p>
              )}
            </div>

            {/* Job ID */}
            <div>
              <label className="block text-xs text-gray-500 mb-1.5">Job ID to poll during test</label>
              <input
                value={jobId}
                onChange={e => setJobId(e.target.value)}
                disabled={running}
                placeholder="JOB-CA-0000000407"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono focus:outline-none focus:border-gray-600 disabled:opacity-50 placeholder-gray-700"
              />
            </div>

            {/* RPM levels info */}
            <div className="bg-gray-800/50 rounded-lg px-3 py-2.5 text-xs text-gray-500">
              <p className="font-medium text-gray-400 mb-1">RPM levels tested:</p>
              <p className="font-mono">5 → 10 → 20 → 30 → 40 → 50 → 60 → 80 → 100</p>
              <p className="mt-1.5">5 requests per level. Stops when &gt;50% throttled. Estimated time: ~3–6 min.</p>
            </div>

            {startError && (
              <p className="text-xs text-red-400 flex items-center gap-1.5">
                <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {startError}
              </p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={startTest}
                disabled={running || !isRunning}
                className="flex items-center gap-2 px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                Start Test
              </button>
              {running && (
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                  Running in worker… ID: {testId?.slice(-8)}
                </div>
              )}
            </div>
          </div>

          {/* Live log */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ height: 340 }}>
            <div className="px-4 py-2.5 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Live Log</h2>
              <span className="text-[10px] text-gray-700">{logs.length} entries</span>
            </div>
            <div className="overflow-y-auto flex-1 font-mono text-[11px] p-3 space-y-0.5">
              {logs.length === 0 ? (
                <p className="text-gray-700 italic text-center mt-8">Log output appears here when a test runs</p>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-gray-700 flex-shrink-0">{fmtTime(log.timestamp)}</span>
                    <span className={LOG_LEVEL_STYLES[log.level]}>{log.message}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        </div>

        {/* Right — Results */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Results</h2>
            {phaseResults.length > 0 && (
              <span className="text-xs text-gray-500">
                Max safe: <span className={`font-semibold ${phaseResults[0].maxSafeRpm > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {phaseResults[0].maxSafeRpm > 0 ? `${phaseResults[0].maxSafeRpm} RPM` : "blocked"}
                </span>
              </span>
            )}
          </div>

          {phaseResults.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
              <FlaskConical className="w-8 h-8 text-gray-700 mx-auto mb-2" />
              <p className="text-gray-600 text-sm">No results yet</p>
              <p className="text-gray-700 text-xs mt-1">Select a running worker account and start the test</p>
            </div>
          ) : (
            phaseResults.map(result => <PhaseTable key={result.phase} result={result} />)
          )}

          {phaseResults.length > 0 && !running && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Recommendation</h3>
              {phaseResults.map(p => {
                const safe = p.maxSafeRpm;
                return (
                  <div key={p.phase} className="flex items-start gap-2.5 text-sm">
                    {safe > 0
                      ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 mt-0.5" />
                      : <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5" />
                    }
                    <div>
                      {safe > 0 ? (
                        <p className="text-gray-300">
                          Set polling interval to{" "}
                          <span className="font-mono text-white">{Math.round(60_000 / safe)}ms+</span>
                          {" "}per worker for max {safe} RPM.
                        </p>
                      ) : (
                        <p className="text-gray-500 italic">All levels throttled — check account session</p>
                      )}
                      {safe > 0 && (
                        <p className="text-xs text-gray-600 mt-0.5">
                          Recommended: use 80% headroom →{" "}
                          <span className="font-mono">{Math.round(60_000 / (safe * 0.8))}ms</span> interval
                          ({Math.round(safe * 0.8)} RPM)
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
