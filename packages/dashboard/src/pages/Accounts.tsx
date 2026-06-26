import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAccounts, deleteAccount, fetchProxies, type Account } from "../lib/api";
import { startWorker, stopWorker } from "../lib/api";
import { Plus, Trash2, Pencil, Play, Square, AlertTriangle } from "lucide-react";
import { AccountModal } from "../components/AccountModal";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    POLLING: "bg-green-900 text-green-300",
    RUNNING: "bg-green-900 text-green-300",
    IDLE:    "bg-gray-800 text-gray-400",
    ERROR:   "bg-red-900 text-red-300",
    BANNED:  "bg-red-900 text-red-300",
    PAUSED:  "bg-yellow-900 text-yellow-300",
    STARTING:"bg-blue-900 text-blue-300",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] ?? colors.IDLE}`}>
      {status}
    </span>
  );
}

export function Accounts() {
  const qc = useQueryClient();
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccounts,
  });
  const [showAdd, setShowAdd] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isActive = (status: string) =>
    ["POLLING", "RUNNING", "STARTING", "LOGGING_IN", "WAITING_OTP", "APPLYING", "CAPTCHA_SOLVING"].includes(status);

  const del = useMutation({
    mutationFn: async (a: Account) => {
      // Stop the container first if running, then delete the record
      if (isActive(a.status)) await stopWorker(a.id).catch(() => {});
      await deleteAccount(a.id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      setConfirmDeleteId(null);
    },
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Accounts</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-500"
        >
          <Plus className="w-4 h-4" /> Add Account
        </button>
      </div>

      {isLoading ? (
        <p className="text-gray-500">Loading…</p>
      ) : (
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900">
                {["Email", "Country", "Jobs", "Status", "Captures", "Proxy", "Actions"].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {accounts.map(a => (
                <tr key={a.id} className="hover:bg-gray-900/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-sm">{a.email}</td>
                  <td className="px-4 py-3 text-gray-400">{a.country}</td>
                  <td className="px-4 py-3 text-gray-400">{a.jobIds.length}</td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-3 text-gray-400">{a._count?.captures ?? 0}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs truncate max-w-[140px]">
                    {a.proxy ? (a.proxy.label ?? a.proxy.url.slice(0, 30) + "…") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {/* Start / Stop */}
                      {isActive(a.status) ? (
                        <button
                          onClick={() => stopWorker(a.id).then(() => qc.invalidateQueries({ queryKey: ["accounts"] }))}
                          title="Stop worker"
                          className="p-1.5 rounded-lg bg-red-900 hover:bg-red-800 text-red-300"
                        >
                          <Square className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => startWorker(a.id).then(() => qc.invalidateQueries({ queryKey: ["accounts"] }))}
                          title="Start worker"
                          className="p-1.5 rounded-lg bg-green-900 hover:bg-green-800 text-green-300"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Edit */}
                      <button
                        onClick={() => setEditAccount(a)}
                        title="Edit account"
                        className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-blue-400"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>

                      {/* Delete — two-step */}
                      {confirmDeleteId === a.id ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => del.mutate(a)}
                            disabled={del.isPending}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs font-medium"
                          >
                            <AlertTriangle className="w-3 h-3" />
                            {del.isPending ? "Deleting…" : "Confirm"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 rounded-lg text-gray-500 hover:text-gray-300 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(a.id)}
                          title="Delete account"
                          className="p-1.5 rounded-lg bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-600">No accounts yet</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AccountModal onClose={() => setShowAdd(false)} />}
      {editAccount && <AccountModal account={editAccount} onClose={() => setEditAccount(null)} />}
    </div>
  );
}
