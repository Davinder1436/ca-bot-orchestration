import React, { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, Trash2, ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import type { Account } from "../lib/api";

// ─── Types ───────────────────────────────────────────────────────────────────

type TabType = "polling" | "tests";
type RunStatus = "running" | "stopped" | "crashed" | "completed" | "unknown";

interface RunMeta {
  runId?: string;
  testId?: string;
  accountId: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  email?: string;
  jobIds?: string[];
  jobId?: string;
  error?: string;
  maxSafeRpm?: number;
}

interface LogEntry {
  ts: number;
  level?: string;
  message: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString("en-CA", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtDuration(startedAt: number, endedAt?: number) {
  const ms = (endedAt ?? Date.now()) - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const STATUS_STYLES: Record<string, string> = {
  running:   "bg-blue-900/40 text-blue-400 border-blue-800/50",
  stopped:   "bg-gray-800 text-gray-400 border-gray-700",
  completed: "bg-emerald-900/40 text-emerald-400 border-emerald-800/50",
  crashed:   "bg-red-900/40 text-red-400 border-red-800/50",
  unknown:   "bg-gray-800 text-gray-600 border-gray-700",
};

function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`px-1.5 py-0.5 border rounded-full text-[10px] font-semibold ${STATUS_STYLES[status] ?? STATUS_STYLES.unknown}`}>
      {status.toUpperCase()}
    </span>
  );
}

const LOG_COLORS: Record<string, string> = {
  info:    "text-gray-400",
  warn:    "text-amber-400",
  success: "text-emerald-400",
  error:   "text-red-400",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function Logs() {
  const [accounts, setAccounts]     = useState<Account[]>([]);
  const [accountId, setAccountId]   = useState("");
  const [tab, setTab]               = useState<TabType>("polling");

  const [runs, setRuns]             = useState<RunMeta[]>([]);
  const [selected, setSelected]     = useState<RunMeta | null>(null);
  const [logs, setLogs]             = useState<LogEntry[]>([]);

  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [deletingId, setDeletingId]   = useState<string | null>(null);

  // Accounts
  useEffect(() => {
    api.get<Account[]>("/accounts").then(r => setAccounts(r.data)).catch(() => {});
  }, []);

  // Load run list whenever account or tab changes
  const loadRuns = useCallback(async () => {
    if (!accountId) { setRuns([]); return; }
    setLoadingRuns(true);
    setSelected(null);
    setLogs([]);
    try {
      const url = tab === "polling"
        ? `/runs?accountId=${accountId}`
        : `/test-runs?accountId=${accountId}`;
      const resp = await api.get<RunMeta[]>(url);
      setRuns(resp.data);
    } catch {
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  }, [accountId, tab]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Select a run and fetch its logs
  const selectRun = async (run: RunMeta) => {
    const id = run.runId ?? run.testId!;
    if ((selected?.runId ?? selected?.testId) === id) return;
    setSelected(run);
    setLoadingLogs(true);
    setLogs([]);
    try {
      const url = tab === "polling" ? `/runs/${id}/logs` : `/test-runs/${id}/logs`;
      const resp = await api.get<LogEntry[]>(url);
      setLogs(resp.data);
    } catch {
      setLogs([]);
    } finally {
      setLoadingLogs(false);
    }
  };

  // Delete a run
  const deleteRun = async (run: RunMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    const id = run.runId ?? run.testId!;
    setDeletingId(id);
    try {
      const url = tab === "polling" ? `/runs/${id}` : `/test-runs/${id}`;
      await api.delete(url);
      setRuns(prev => prev.filter(r => (r.runId ?? r.testId) !== id));
      if ((selected?.runId ?? selected?.testId) === id) {
        setSelected(null);
        setLogs([]);
      }
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  const selectedId = selected?.runId ?? selected?.testId;

  return (
    <div className="p-6 h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            Logs
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Persisted worker and test run logs — stored in Redis, 30-day TTL
          </p>
        </div>
        <button
          onClick={loadRuns}
          disabled={!accountId || loadingRuns}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-xs text-gray-300 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loadingRuns ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <select
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600 w-64"
        >
          <option value="">— Select account —</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>{a.email} ({a.country})</option>
          ))}
        </select>

        <div className="flex items-center gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {(["polling", "tests"] as TabType[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === t ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t === "polling" ? "Polling Runs" : "Test Runs"}
            </button>
          ))}
        </div>
      </div>

      {/* Main two-panel layout */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Left — Run list */}
        <div className="w-72 flex-shrink-0 bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden">
          <div className="px-3 py-2.5 border-b border-gray-800 flex-shrink-0 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {tab === "polling" ? "Polling Runs" : "Test Runs"}
            </span>
            <span className="text-[10px] text-gray-700">{runs.length}</span>
          </div>

          <div className="overflow-y-auto flex-1">
            {!accountId ? (
              <p className="text-gray-700 text-xs text-center py-10 px-4">Select an account to view runs</p>
            ) : loadingRuns ? (
              <p className="text-gray-700 text-xs text-center py-10">Loading...</p>
            ) : runs.length === 0 ? (
              <p className="text-gray-700 text-xs text-center py-10 px-4 leading-relaxed">
                No {tab === "polling" ? "polling" : "test"} runs found.<br />
                Runs appear here after a worker starts.
              </p>
            ) : (
              runs.map(run => {
                const id = run.runId ?? run.testId!;
                const isSelected = selectedId === id;
                return (
                  <button
                    key={id}
                    onClick={() => selectRun(run)}
                    className={`w-full text-left px-3 py-3 border-b border-gray-800/50 transition-colors hover:bg-gray-800/60 ${isSelected ? "bg-gray-800" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1.5">
                          <StatusBadge status={run.status} />
                          {run.maxSafeRpm !== undefined && run.maxSafeRpm > 0 && (
                            <span className="text-[10px] text-emerald-600 font-mono">{run.maxSafeRpm} RPM max</span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400">{fmtDate(run.startedAt)}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-gray-600">
                            {fmtDuration(run.startedAt, run.endedAt)}
                          </span>
                          <span className="text-[10px] text-gray-700 font-mono truncate">
                            …{id.slice(-8)}
                          </span>
                        </div>
                        {run.error && (
                          <p className="text-[10px] text-red-500 mt-0.5 truncate" title={run.error}>
                            {run.error.slice(0, 50)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                        <button
                          onClick={e => deleteRun(run, e)}
                          disabled={deletingId === id}
                          className="p-1 text-gray-700 hover:text-red-400 transition-colors disabled:opacity-30"
                          title="Delete run"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        <ChevronRight className={`w-3.5 h-3.5 transition-colors ${isSelected ? "text-gray-400" : "text-gray-700"}`} />
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right — Log viewer */}
        <div className="flex-1 bg-gray-900 border border-gray-800 rounded-xl flex flex-col overflow-hidden min-w-0">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Activity className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-600 text-sm">Select a run to view its logs</p>
                <p className="text-gray-700 text-xs mt-1">Logs are stored per-run and available after container stops</p>
              </div>
            </div>
          ) : (
            <>
              {/* Meta bar */}
              <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <StatusBadge status={selected.status} />
                  <span className="text-xs font-mono text-gray-600 truncate">{selectedId}</span>
                  {selected.jobId && (
                    <span className="text-[11px] text-gray-500 font-mono hidden lg:block">{selected.jobId}</span>
                  )}
                  {selected.error && (
                    <span className="text-xs text-red-400 truncate max-w-xs hidden xl:block" title={selected.error}>
                      {selected.error.slice(0, 80)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-600">
                  <span>{fmtDate(selected.startedAt)}</span>
                  {selected.endedAt && <span>{fmtDuration(selected.startedAt, selected.endedAt)}</span>}
                  <span className="text-gray-700">{logs.length} lines</span>
                </div>
              </div>

              {/* Log lines */}
              <div className="overflow-y-auto flex-1 font-mono text-[11px] p-3 space-y-0.5">
                {loadingLogs ? (
                  <p className="text-gray-600 text-center py-10">Loading logs...</p>
                ) : logs.length === 0 ? (
                  <p className="text-gray-600 text-center py-10 italic">No logs stored for this run</p>
                ) : (
                  logs.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2 leading-relaxed">
                      <span className="text-gray-700 flex-shrink-0 w-28">
                        {new Date(entry.ts).toLocaleTimeString("en-CA", {
                          hour: "2-digit", minute: "2-digit", second: "2-digit",
                        })}
                      </span>
                      {entry.level && (
                        <span className={`flex-shrink-0 w-14 ${LOG_COLORS[entry.level] ?? "text-gray-500"}`}>
                          {entry.level}
                        </span>
                      )}
                      <span className="text-gray-300 break-all min-w-0">{entry.message}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
