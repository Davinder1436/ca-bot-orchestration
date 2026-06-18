import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAccounts, createAccount, deleteAccount, updateAccount, fetchProxies, type Account } from "../lib/api";
import { Plus, Trash2, Play, Square, ChevronDown } from "lucide-react";
import { startWorker, stopWorker } from "../lib/api";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    POLLING: "bg-green-900 text-green-300",
    RUNNING: "bg-green-900 text-green-300",
    IDLE: "bg-gray-800 text-gray-400",
    ERROR: "bg-red-900 text-red-300",
    BANNED: "bg-red-900 text-red-300",
    PAUSED: "bg-yellow-900 text-yellow-300",
    STARTING: "bg-blue-900 text-blue-300",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[status] ?? colors.IDLE}`}>
      {status}
    </span>
  );
}

function AddAccountModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: proxies = [] } = useQuery({ queryKey: ["proxies"], queryFn: fetchProxies });
  const [form, setForm] = useState({ email: "", pin: "", country: "CA", jobIds: "", proxyId: "", notes: "" });
  const { mutate, isPending } = useMutation({
    mutationFn: (data: Partial<Account>) => createAccount(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutate({
      ...form,
      jobIds: form.jobIds.split(",").map((s) => s.trim()).filter(Boolean),
      proxyId: form.proxyId || undefined,
      notes: form.notes || undefined,
    } as unknown as Account);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-4">Add Account</h2>
        <form onSubmit={submit} className="space-y-3">
          {[
            { label: "Email", key: "email", type: "email", placeholder: "user@gmail.com" },
            { label: "PIN (6 digits)", key: "pin", type: "password", placeholder: "123456" },
            { label: "Job IDs (comma separated)", key: "jobIds", type: "text", placeholder: "JOB-123, JOB-456" },
            { label: "Notes", key: "notes", type: "text", placeholder: "Optional" },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key}>
              <label className="block text-xs text-gray-400 mb-1">{label}</label>
              <input
                type={type}
                placeholder={placeholder}
                value={(form as Record<string, string>)[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                required={key === "email" || key === "pin"}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
              />
            </div>
          ))}

          <div>
            <label className="block text-xs text-gray-400 mb-1">Country</label>
            <select
              value={form.country}
              onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            >
              <option value="CA">Canada</option>
              <option value="US">United States</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Proxy</label>
            <select
              value={form.proxyId}
              onChange={(e) => setForm((f) => ({ ...f, proxyId: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">No proxy</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>{p.label ?? p.url}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-lg border border-gray-700 text-sm hover:bg-gray-800">Cancel</button>
            <button type="submit" disabled={isPending} className="flex-1 py-2 rounded-lg bg-brand-500 text-black font-medium text-sm hover:bg-brand-600 disabled:opacity-50">
              {isPending ? "Adding..." : "Add Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Accounts() {
  const qc = useQueryClient();
  const { data: accounts = [], isLoading } = useQuery({ queryKey: ["accounts"], queryFn: fetchAccounts });
  const [showAdd, setShowAdd] = useState(false);

  const del = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });

  const isActive = (status: string) =>
    ["POLLING", "RUNNING", "STARTING", "LOGGING_IN", "WAITING_OTP", "APPLYING"].includes(status);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Accounts</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-black rounded-lg text-sm font-medium hover:bg-brand-600"
        >
          <Plus className="w-4 h-4" /> Add Account
        </button>
      </div>

      {isLoading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900">
                {["Email", "Country", "Jobs", "Status", "Captures", "Proxy", "Actions"].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {accounts.map((a) => (
                <tr key={a.id} className="hover:bg-gray-900/40 transition-colors">
                  <td className="px-4 py-3 font-mono">{a.email}</td>
                  <td className="px-4 py-3 text-gray-400">{a.country}</td>
                  <td className="px-4 py-3 text-gray-400">{a.jobIds.length}</td>
                  <td className="px-4 py-3"><StatusBadge status={a.status} /></td>
                  <td className="px-4 py-3 text-gray-400">{a._count?.captures ?? 0}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs truncate max-w-[140px]">
                    {a.proxy ? a.proxy.label ?? a.proxy.url.slice(0, 30) + "..." : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {isActive(a.status) ? (
                        <button onClick={() => stopWorker(a.id).then(() => qc.invalidateQueries({ queryKey: ["accounts"] }))} className="p-1.5 rounded-lg bg-red-900 hover:bg-red-800 text-red-300">
                          <Square className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button onClick={() => startWorker(a.id).then(() => qc.invalidateQueries({ queryKey: ["accounts"] }))} className="p-1.5 rounded-lg bg-green-900 hover:bg-green-800 text-green-300">
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => del.mutate(a.id)} className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {accounts.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-600">No accounts yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}
