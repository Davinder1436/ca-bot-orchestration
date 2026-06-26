import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Activity, Clock, Zap, AlertTriangle, CheckCircle, Wifi, WifiOff, RefreshCw, SlidersHorizontal,
} from "lucide-react";
import { getSocket } from "../lib/socket";
import { api } from "../lib/api";
import type { BusEvent, Account } from "../lib/api";

// ─── Types ───────────────────────────────────────────────────────────────────

type PollResult = "active" | "empty" | "error" | "throttled";

interface PollTick {
  accountId: string;
  email: string;
  jobId: string;
  result: PollResult;
  slotsFound: number;
  error: string | null;
  statusCode: number | null;
  durationMs: number;
  isWarmup: boolean;
  intervalMs: number;
  estimatedRpm: number;
  consecutiveEmpty: number;
  timestamp: number;
}

// Seed: what we know from the REST API (survives between poll events)
interface WorkerSeed {
  accountId: string;
  email: string;
  jobIds: string[];
  state: string; // POLLING, LOGGING_IN, etc.
}

// accountId → jobId → ticks (newest first)
type PollingState = Record<string, Record<string, PollTick[]>>;

const MAX_TICKS  = 40;
const MAX_FEED   = 120;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RESULT_STYLES: Record<PollResult, { bg: string; text: string; label: string }> = {
  active:    { bg: "bg-emerald-500", text: "text-emerald-400", label: "Active"    },
  empty:     { bg: "bg-gray-700",    text: "text-gray-500",    label: "Empty"     },
  throttled: { bg: "bg-amber-500",   text: "text-amber-400",   label: "Throttled" },
  error:     { bg: "bg-red-500",     text: "text-red-400",     label: "Error"     },
};

const STATE_STYLES: Record<string, string> = {
  POLLING:    "text-emerald-400 bg-emerald-900/30 border-emerald-800/50",
  LOGGING_IN: "text-blue-400 bg-blue-900/30 border-blue-800/50",
  STARTING:   "text-blue-400 bg-blue-900/30 border-blue-800/50",
  CAPTCHA_SOLVING: "text-purple-400 bg-purple-900/30 border-purple-800/50",
  WAITING_OTP: "text-yellow-400 bg-yellow-900/30 border-yellow-800/50",
  ERROR:      "text-red-400 bg-red-900/30 border-red-800/50",
  IDLE:       "text-gray-500 bg-gray-800/30 border-gray-700/50",
};

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtMs(ms: number) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`; }
function shortJobId(id: string) { return id.length > 12 ? `…${id.slice(-10)}` : id; }

// ─── Sub-components ──────────────────────────────────────────────────────────

function ResultDot({ result, ts }: { result: PollResult; ts: number }) {
  const { bg } = RESULT_STYLES[result];
  return (
    <div
      className={`w-3 h-3 rounded-sm flex-shrink-0 ${bg} opacity-90`}
      title={`${RESULT_STYLES[result].label} at ${fmtTime(ts)}`}
    />
  );
}

function JobRow({ jobId, ticks }: { jobId: string; ticks: PollTick[] }) {
  const latest      = ticks[0];
  const activeCount = ticks.filter(t => t.result === "active").length;
  const throttled   = ticks.filter(t => t.result === "throttled").length;
  const errors      = ticks.filter(t => t.result === "error").length;

  return (
    <div className="py-2.5 border-b border-gray-800/60 last:border-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-gray-400">{shortJobId(jobId)}</span>
          {latest && (
            <span className={`text-xs font-medium ${RESULT_STYLES[latest.result].text}`}>
              {latest.result === "active"
                ? `✓ ${latest.slotsFound} slot${latest.slotsFound !== 1 ? "s" : ""}`
                : RESULT_STYLES[latest.result].label}
            </span>
          )}
          {!latest && <span className="text-xs text-gray-700 italic">awaiting first poll…</span>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-600">
          {activeCount > 0 && <span className="text-emerald-500">{activeCount} hits</span>}
          {throttled   > 0 && <span className="text-amber-500">{throttled} throttled</span>}
          {errors      > 0 && <span className="text-red-500">{errors} errors</span>}
          {latest && <span>{fmtMs(latest.durationMs)}</span>}
        </div>
      </div>
      {/* Timeline bar — newest on right */}
      <div className="flex items-center gap-0.5 flex-wrap min-h-[12px]">
        {[...ticks].reverse().map((t, i) => (
          <ResultDot key={`${t.timestamp}-${i}`} result={t.result} ts={t.timestamp} />
        ))}
        {ticks.length === 0 && (
          <div className="h-3 w-48 rounded-sm bg-gray-800/60 animate-pulse" />
        )}
      </div>
    </div>
  );
}

// Rate slider: min 500ms, max 30000ms, step 500ms
const SLIDER_MIN = 500;
const SLIDER_MAX = 30_000;
const SLIDER_STEP = 500;

function rpmFromInterval(intervalMs: number, jobCount: number) {
  if (intervalMs <= 0 || jobCount <= 0) return 0;
  // RPM = jobCount × 60000 / (interval + avg stagger per job)
  // Stagger adds ~2250ms per job gap: (jobCount-1) × 2250
  const avgCycleMs = intervalMs + Math.max(0, jobCount - 1) * 2_250;
  return Math.round((jobCount * 60_000) / avgCycleMs);
}

function AccountCard({
  seed,
  jobMap,
}: {
  seed: WorkerSeed;
  jobMap: Record<string, PollTick[]>;
}) {
  const allLatest = Object.values(jobMap).map(t => t[0]).filter(Boolean);
  const latest    = allLatest.sort((a, b) => b.timestamp - a.timestamp)[0];
  const rpm       = latest?.estimatedRpm ?? 0;
  const isWarmup  = latest?.isWarmup ?? false;
  const liveInterval = latest?.intervalMs ?? 5_000;
  const secAgo    = latest ? Math.round((Date.now() - latest.timestamp) / 1000) : null;

  const allJobIds = Array.from(new Set([...seed.jobIds, ...Object.keys(jobMap)]));

  const overallResult: PollResult | null = allLatest.length === 0 ? null
    : allLatest.some(t => t.result === "active")    ? "active"
    : allLatest.some(t => t.result === "error")     ? "error"
    : allLatest.some(t => t.result === "throttled") ? "throttled"
    : "empty";

  const stateStyle = STATE_STYLES[seed.state] ?? STATE_STYLES["IDLE"];

  // Rate slider state
  const [showSlider, setShowSlider]   = useState(false);
  const [sliderVal, setSliderVal]     = useState(liveInterval);
  const [applying, setApplying]       = useState(false);
  const [applyStatus, setApplyStatus] = useState<"idle" | "ok" | "err">("idle");

  const previewRpm = rpmFromInterval(sliderVal, allJobIds.length);
  const minSafeMs  = allJobIds.length > 0 ? Math.ceil((allJobIds.length * 60_000) / 100) : 500;

  const applyRate = useCallback(async () => {
    setApplying(true);
    setApplyStatus("idle");
    try {
      await api.patch(`/workers/${seed.accountId}/polling-rate`, { intervalMs: sliderVal });
      setApplyStatus("ok");
    } catch {
      setApplyStatus("err");
    } finally {
      setApplying(false);
      setTimeout(() => setApplyStatus("idle"), 3_000);
    }
  }, [seed.accountId, sliderVal]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Account header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-gray-800">
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
            overallResult ? RESULT_STYLES[overallResult].bg : "bg-gray-600"
          } ${overallResult === "active" ? "animate-pulse" : ""}`} />
          <div>
            <p className="text-sm font-medium text-white">{seed.email}</p>
            <p className="text-[11px] text-gray-500 mt-0.5">{seed.accountId.slice(0, 12)}…</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap justify-end">
          <span className={`px-2 py-0.5 border rounded text-[10px] font-semibold ${stateStyle}`}>
            {seed.state}
          </span>
          {isWarmup && (
            <span className="px-2 py-0.5 bg-blue-900/40 text-blue-400 border border-blue-800/50 rounded text-[10px] font-medium">
              WARMUP
            </span>
          )}
          {allLatest.length > 0 && (
            <>
              <div className="flex items-center gap-1" title="Estimated RPM">
                <Zap className={`w-3 h-3 ${rpm > 80 ? "text-red-400" : "text-gray-600"}`} />
                <span className={rpm > 80 ? "text-red-400" : rpm > 50 ? "text-amber-400" : ""}>{rpm} RPM</span>
              </div>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-gray-600" />
                <span>{(liveInterval / 1000).toFixed(1)}s</span>
              </div>
            </>
          )}
          <span className="text-gray-600">{allJobIds.length} job{allJobIds.length !== 1 ? "s" : ""}</span>
          {secAgo !== null && (
            <span>{secAgo < 5 ? <span className="text-emerald-500">just now</span> : `${secAgo}s ago`}</span>
          )}
          {/* Rate knob toggle */}
          <button
            onClick={() => { setShowSlider(v => !v); setSliderVal(liveInterval); }}
            className={`p-1 rounded transition-colors ${showSlider ? "text-brand-400 bg-gray-800" : "text-gray-600 hover:text-gray-300 hover:bg-gray-800"}`}
            title="Adjust polling rate"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Rate slider panel */}
      {showSlider && (
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-950/60">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] text-gray-400 font-medium">Polling interval</span>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-white font-mono">{(sliderVal / 1000).toFixed(1)}s</span>
                  <span className={`font-medium ${previewRpm > 100 ? "text-red-400" : previewRpm > 80 ? "text-amber-400" : "text-emerald-400"}`}>
                    ~{previewRpm} RPM
                  </span>
                  {sliderVal < minSafeMs && (
                    <span className="text-amber-400 text-[10px]">floor {(minSafeMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
              </div>
              <input
                type="range"
                min={SLIDER_MIN}
                max={SLIDER_MAX}
                step={SLIDER_STEP}
                value={sliderVal}
                onChange={e => setSliderVal(parseInt(e.target.value))}
                className="w-full h-1.5 rounded-full appearance-none bg-gray-700 accent-brand-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-gray-700 mt-1">
                <span>0.5s (fast)</span>
                <span>30s (slow)</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <button
                onClick={applyRate}
                disabled={applying}
                className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-medium transition-colors"
              >
                {applying ? "Applying…" : "Apply"}
              </button>
              {applyStatus === "ok"  && <span className="text-[10px] text-emerald-400">Applied ✓</span>}
              {applyStatus === "err" && <span className="text-[10px] text-red-400">Failed ✗</span>}
            </div>
          </div>
          <p className="text-[10px] text-gray-700 mt-2">
            Max safe interval enforced to stay under 100 RPM across {allJobIds.length} job{allJobIds.length !== 1 ? "s" : ""} ({(minSafeMs / 1000).toFixed(1)}s min).
          </p>
        </div>
      )}

      {/* Per-job rows */}
      <div className="px-4 divide-y divide-gray-800/30">
        {allJobIds.length === 0 ? (
          <p className="py-4 text-xs text-gray-700 text-center italic">No jobs assigned</p>
        ) : (
          allJobIds.map(jid => (
            <JobRow key={jid} jobId={jid} ticks={jobMap[jid] ?? []} />
          ))
        )}
      </div>
    </div>
  );
}

function FeedRow({ tick }: { tick: PollTick }) {
  const s = RESULT_STYLES[tick.result];
  return (
    <div className="flex items-center gap-3 px-4 py-1.5 hover:bg-gray-800/30 text-xs border-b border-gray-800/30 last:border-0">
      <span className="text-gray-600 font-mono w-20 flex-shrink-0">{fmtTime(tick.timestamp)}</span>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.bg}`} />
      <span className="text-gray-400 truncate w-36 flex-shrink-0">{tick.email.split("@")[0]}</span>
      <span className="font-mono text-gray-600 truncate w-24 flex-shrink-0">{shortJobId(tick.jobId)}</span>
      <span className={`font-medium w-20 flex-shrink-0 ${s.text}`}>
        {tick.result === "active" ? `✓ ${tick.slotsFound} slots` : s.label}
      </span>
      <span className="text-gray-700 w-16 flex-shrink-0">{fmtMs(tick.durationMs)}</span>
      {tick.error && <span className="text-red-500 truncate" title={tick.error}>{tick.error.slice(0, 50)}</span>}
      {tick.isWarmup && <span className="text-blue-600 text-[10px]">warmup</span>}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Polling() {
  const [seeds, setSeeds]               = useState<Record<string, WorkerSeed>>({});
  const [pollingState, setPollingState] = useState<PollingState>({});
  const [feed, setFeed]                 = useState<PollTick[]>([]);
  const [connected, setConnected]       = useState(false);
  const [totalTicks, setTotalTicks]     = useState(0);
  const [loading, setLoading]           = useState(true);
  const [refreshAt, setRefreshAt]       = useState(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── API seed: load running workers + account info ─────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const [workersRes, accountsRes] = await Promise.all([
          api.get<{ running: string[] }>("/workers"),
          api.get<Account[]>("/accounts"),
        ]);

        if (cancelled) return;

        const running = new Set(workersRes.data.running);
        const accountMap: Record<string, Account> = {};
        for (const acc of accountsRes.data) accountMap[acc.id] = acc;

        const newSeeds: Record<string, WorkerSeed> = {};
        for (const accountId of running) {
          const acc = accountMap[accountId];
          if (!acc) continue;
          newSeeds[accountId] = {
            accountId,
            email:   acc.email,
            jobIds:  acc.jobIds ?? [],
            state:   acc.status ?? "POLLING",
          };
        }
        setSeeds(newSeeds);
      } catch {
        // ignore — socket events still work
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [refreshAt]);

  // Auto-refresh seed every 30s
  useEffect(() => {
    timerRef.current = setInterval(() => setRefreshAt(Date.now()), 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = getSocket();

    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    setConnected(socket.connected);

    const onEvent = (event: BusEvent) => {
      // Track worker state changes to update seed badges
      if (event.type === "worker:state") {
        const p = event.payload as { accountId: string; state: string };
        setSeeds(prev => {
          if (!prev[p.accountId]) return prev;
          return { ...prev, [p.accountId]: { ...prev[p.accountId], state: p.state } };
        });
        return;
      }

      if (event.type !== "poll:tick") return;
      const tick = event.payload as unknown as PollTick;

      setTotalTicks(n => n + 1);

      setPollingState(prev => {
        const acct    = prev[tick.accountId] ?? {};
        const existing = acct[tick.jobId] ?? [];
        const updated = [tick, ...existing].slice(0, MAX_TICKS);
        return { ...prev, [tick.accountId]: { ...acct, [tick.jobId]: updated } };
      });

      // Auto-add to seeds if worker wasn't fetched yet
      setSeeds(prev => {
        if (prev[tick.accountId]) return prev;
        return {
          ...prev,
          [tick.accountId]: { accountId: tick.accountId, email: tick.email, jobIds: [], state: "POLLING" },
        };
      });

      setFeed(prev => [tick, ...prev].slice(0, MAX_FEED));
    };

    socket.on("connect",    onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("event",      onEvent);

    return () => {
      socket.off("connect",    onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("event",      onEvent);
    };
  }, []);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const seedIds    = Object.keys(seeds);
  const totalJobs  = seedIds.reduce((n, aid) => {
    const fromSeed   = seeds[aid].jobIds.length;
    const fromEvents = Object.keys(pollingState[aid] ?? {}).length;
    return n + Math.max(fromSeed, fromEvents);
  }, 0);

  const recentFeed     = feed.filter(t => Date.now() - t.timestamp < 60_000);
  const avgRpm         = recentFeed.length;
  const totalThrottled = feed.filter(t => t.result === "throttled").length;

  return (
    <div className="p-6 space-y-6 min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Polling Monitor</h1>
          <p className="text-sm text-gray-500 mt-0.5">Real-time per-job polling activity and rate tracking</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setRefreshAt(Date.now())}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors px-2 py-1 rounded hover:bg-gray-800"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            {connected
              ? <><Wifi className="w-3.5 h-3.5 text-emerald-500" /><span className="text-emerald-500">Live</span></>
              : <><WifiOff className="w-3.5 h-3.5 text-red-500" /><span className="text-red-500">Disconnected</span></>
            }
          </div>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Active workers",  value: seedIds.length,   icon: Activity,      color: seedIds.length > 0 ? "text-emerald-400" : "text-gray-600" },
          { label: "Jobs monitored",  value: totalJobs,        icon: CheckCircle,   color: "text-blue-400" },
          { label: "RPM (last 60s)",  value: avgRpm,           icon: Zap,           color: avgRpm > 80 ? "text-red-400" : "text-gray-300" },
          { label: "Throttle hits",   value: totalThrottled,   icon: AlertTriangle, color: totalThrottled > 0 ? "text-amber-400" : "text-gray-600" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 flex items-center gap-3">
            <Icon className={`w-4 h-4 ${color}`} />
            <div>
              <p className="text-xs text-gray-500">{label}</p>
              <p className={`text-xl font-bold ${color}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left — Account cards */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Workers</h2>

          {loading && seedIds.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
              <div className="w-5 h-5 border-2 border-gray-700 border-t-gray-400 rounded-full animate-spin mx-auto mb-2" />
              <p className="text-gray-600 text-sm">Loading worker status…</p>
            </div>
          ) : seedIds.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
              <Activity className="w-8 h-8 text-gray-700 mx-auto mb-2" />
              <p className="text-gray-600 text-sm">No workers running</p>
              <p className="text-gray-700 text-xs mt-1">Start a worker from the Accounts page</p>
            </div>
          ) : (
            seedIds.map(aid => (
              <AccountCard
                key={aid}
                seed={seeds[aid]}
                jobMap={pollingState[aid] ?? {}}
              />
            ))
          )}
        </div>

        {/* Right — Live activity feed */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: 600 }}>
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
            <h2 className="text-sm font-semibold text-gray-300">Live Activity</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600">{totalTicks.toLocaleString()} polls seen</span>
              {feed.length > 0 && feed[0].result === "active" && (
                <span className="px-2 py-0.5 bg-emerald-900/40 text-emerald-400 border border-emerald-800/50 rounded text-[10px] font-bold animate-pulse">
                  JOB FOUND!
                </span>
              )}
            </div>
          </div>
          {/* Column headers */}
          <div className="flex items-center gap-3 px-4 py-1.5 border-b border-gray-800/60 bg-gray-950/50 flex-shrink-0">
            {[
              ["Time", 80], ["", 8], ["Account", 144], ["Job ID", 96], ["Result", 80], ["Latency", 64],
            ].map(([h, w]) => (
              <span key={h} className="text-[10px] text-gray-700 uppercase tracking-wide font-medium"
                style={{ width: w as number, flexShrink: 0 }}>{h}</span>
            ))}
          </div>
          <div className="overflow-y-auto flex-1">
            {feed.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-gray-600 text-xs italic">Waiting for poll events…</p>
                {seedIds.length > 0 && (
                  <p className="text-gray-700 text-[11px] mt-1">
                    {seeds[seedIds[0]]?.state === "POLLING"
                      ? "Worker is in warm-up (60s between polls) — first event arriving soon"
                      : `Worker state: ${seeds[seedIds[0]]?.state}`}
                  </p>
                )}
              </div>
            ) : (
              feed.map((tick, i) => (
                <FeedRow key={`${tick.timestamp}-${tick.jobId}-${i}`} tick={tick} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-600">
        <span className="font-medium text-gray-500">Legend:</span>
        {Object.entries(RESULT_STYLES).map(([r, s]) => (
          <div key={r} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-sm ${s.bg}`} />
            <span>{s.label}</span>
          </div>
        ))}
        <span className="ml-4 text-gray-700">Timeline: oldest → newest (left to right). Hover dots for timestamp.</span>
      </div>
    </div>
  );
}
