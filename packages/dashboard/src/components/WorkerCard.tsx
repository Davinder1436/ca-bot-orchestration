import React, { useState } from "react";
import { Play, Square, AlertCircle, CheckCircle, Clock, Loader2, Pencil, Trash2 } from "lucide-react";
import type { Account } from "../lib/api";
import { startWorker, stopWorker } from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_CONFIG: Record<string, { color: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  IDLE:            { color: "bg-gray-700 border-gray-600",          icon: Clock,         label: "Idle" },
  STARTING:        { color: "bg-blue-900 border-blue-700",          icon: Loader2,       label: "Starting" },
  LOGGING_IN:      { color: "bg-blue-900 border-blue-700",          icon: Loader2,       label: "Logging In" },
  WAITING_OTP:     { color: "bg-yellow-900 border-yellow-700",      icon: Clock,         label: "Waiting OTP" },
  AUTHENTICATED:   { color: "bg-green-900 border-green-700",        icon: CheckCircle,   label: "Auth OK" },
  POLLING:         { color: "bg-green-900 border-green-700",        icon: CheckCircle,   label: "Polling" },
  APPLYING:        { color: "bg-brand-600 border-yellow-600",       icon: Loader2,       label: "Applying" },
  CAPTCHA_SOLVING: { color: "bg-purple-900 border-purple-700",      icon: Loader2,       label: "Solving CAPTCHA" },
  ERROR:           { color: "bg-red-900 border-red-700",            icon: AlertCircle,   label: "Error" },
  BANNED:          { color: "bg-red-950 border-red-800",            icon: AlertCircle,   label: "Banned" },
  PAUSED:          { color: "bg-gray-800 border-gray-600",          icon: Clock,         label: "Paused" },
};

interface Props {
  account: Account;
  liveStatus?: string;
  onClick?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

export function WorkerCard({ account, liveStatus, onClick, onEdit, onDelete }: Props) {
  const qc = useQueryClient();
  const status = liveStatus ?? account.status;
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.IDLE;
  const Icon = cfg.icon;
  const isRunning = ["STARTING","LOGGING_IN","WAITING_OTP","AUTHENTICATED","POLLING","APPLYING","CAPTCHA_SOLVING"].includes(status);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await startWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await stopWorker(account.id);
    qc.invalidateQueries({ queryKey: ["accounts"] });
  };

  const handleEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    onEdit?.();
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirmDelete) { setConfirmDelete(true); return; }
    onDelete?.();
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  };

  return (
    <div
      className={`rounded-xl border p-4 ${cfg.color} transition-all cursor-pointer hover:brightness-110 hover:scale-[1.02]`}
      onClick={onClick}
    >
      {/* Status row */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${isRunning && !["POLLING","AUTHENTICATED"].includes(status) ? "animate-spin" : ""}`} />
          <span className="text-xs font-medium uppercase tracking-wide opacity-75">{cfg.label}</span>
        </div>
        <span className="text-xs opacity-50">{account.country}</span>
      </div>

      {/* Account info */}
      <p className="font-mono text-sm truncate mb-1">{account.email}</p>
      <p className="text-xs opacity-50 mb-3">
        {account.jobIds.length} job{account.jobIds.length !== 1 ? "s" : ""} monitored
        {account._count ? ` · ${account._count.captures} captured` : ""}
      </p>

      {/* Primary action: start/stop */}
      <div className="flex items-center gap-2 mb-2">
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

        {/* Edit button */}
        {onEdit && (
          <button
            onClick={handleEdit}
            title="Edit account"
            className="p-1.5 rounded-lg bg-black/20 hover:bg-black/40 text-white/50 hover:text-blue-300 transition-colors"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}

        {/* Delete button — two-step confirm */}
        {onDelete && !confirmDelete && (
          <button
            onClick={handleDeleteClick}
            title="Delete account"
            className="p-1.5 rounded-lg bg-black/20 hover:bg-red-900 text-white/50 hover:text-red-300 transition-colors ml-auto"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
        {onDelete && confirmDelete && (
          <div className="flex items-center gap-1 ml-auto" onClick={e => e.stopPropagation()}>
            <button
              onClick={handleDeleteClick}
              className="text-[10px] px-2 py-1 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium"
            >
              Confirm
            </button>
            <button
              onClick={handleCancelDelete}
              className="text-[10px] px-1.5 py-1 rounded-lg text-white/40 hover:text-white/70"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <p className="text-[10px] opacity-30 text-center">click for details</p>
    </div>
  );
}
