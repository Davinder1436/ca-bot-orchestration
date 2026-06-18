import React from "react";
import { Play, Square, AlertCircle, CheckCircle, Clock, Loader2 } from "lucide-react";
import type { Account } from "../lib/api";
import { startWorker, stopWorker } from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_CONFIG: Record<string, { color: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  IDLE:       { color: "bg-gray-700 border-gray-600",         icon: Clock,         label: "Idle" },
  STARTING:   { color: "bg-blue-900 border-blue-700",         icon: Loader2,       label: "Starting" },
  LOGGING_IN: { color: "bg-blue-900 border-blue-700",         icon: Loader2,       label: "Logging In" },
  WAITING_OTP:{ color: "bg-yellow-900 border-yellow-700",     icon: Clock,         label: "Waiting OTP" },
  AUTHENTICATED: { color: "bg-green-900 border-green-700",    icon: CheckCircle,   label: "Auth OK" },
  POLLING:    { color: "bg-green-900 border-green-700",       icon: CheckCircle,   label: "Polling" },
  APPLYING:   { color: "bg-brand-600 border-yellow-600",      icon: Loader2,       label: "Applying" },
  CAPTCHA_SOLVING: { color: "bg-purple-900 border-purple-700", icon: Loader2,      label: "Solving CAPTCHA" },
  ERROR:      { color: "bg-red-900 border-red-700",           icon: AlertCircle,   label: "Error" },
  BANNED:     { color: "bg-red-950 border-red-800",           icon: AlertCircle,   label: "Banned" },
  PAUSED:     { color: "bg-gray-800 border-gray-600",         icon: Clock,         label: "Paused" },
};

interface Props {
  account: Account;
  liveStatus?: string;
}

export function WorkerCard({ account, liveStatus }: Props) {
  const qc = useQueryClient();
  const status = liveStatus ?? account.status;
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.IDLE;
  const Icon = cfg.icon;
  const isRunning = ["STARTING", "LOGGING_IN", "WAITING_OTP", "AUTHENTICATED", "POLLING", "APPLYING", "CAPTCHA_SOLVING"].includes(status);

  const handleStart = async () => {
    await startWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const handleStop = async () => {
    await stopWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  return (
    <div className={`rounded-xl border p-4 ${cfg.color} transition-all`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${status === "POLLING" || status === "APPLYING" ? "animate-spin" : ""}`} />
          <span className="text-xs font-medium uppercase tracking-wide opacity-75">{cfg.label}</span>
        </div>
        <span className="text-xs opacity-50">{account.country}</span>
      </div>

      <p className="font-mono text-sm truncate mb-1">{account.email}</p>
      <p className="text-xs opacity-50 mb-3">
        {account.jobIds.length} job{account.jobIds.length !== 1 ? "s" : ""} monitored
        {account._count ? ` · ${account._count.captures} captured` : ""}
      </p>

      <div className="flex gap-2">
        {!isRunning ? (
          <button
            onClick={handleStart}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 transition-colors"
          >
            <Play className="w-3 h-3" /> Start
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 transition-colors"
          >
            <Square className="w-3 h-3" /> Stop
          </button>
        )}
      </div>
    </div>
  );
}
