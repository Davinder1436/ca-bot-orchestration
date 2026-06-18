import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchProxies, createProxy, deleteProxy, checkProxy } from "../lib/api";
import { Plus, Trash2, RefreshCw, CheckCircle, XCircle } from "lucide-react";

export function Proxies() {
  const qc = useQueryClient();
  const { data: proxies = [], isLoading } = useQuery({ queryKey: ["proxies"], queryFn: fetchProxies });
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ url: "", zone: "", label: "" });

  const addProxy = useMutation({
    mutationFn: createProxy,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["proxies"] }); setShowAdd(false); setForm({ url: "", zone: "", label: "" }); },
  });

  const delProxy = useMutation({
    mutationFn: deleteProxy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxies"] }),
  });

  const healthCheck = useMutation({
    mutationFn: checkProxy,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["proxies"] }),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Proxy Pool</h1>
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-black rounded-lg text-sm font-medium hover:bg-brand-600">
          <Plus className="w-4 h-4" /> Add Proxy
        </button>
      </div>

      <div className="mb-4 p-4 rounded-xl border border-blue-900 bg-blue-950/30 text-sm text-blue-300">
        <strong>Bright Data setup:</strong> Use format{" "}
        <code className="bg-blue-900/40 px-1 rounded font-mono">http://brd-customer-XXX-zone-residential-session-ACCT_ID:PASSWORD@brd.superproxy.io:22225</code>
        {" "}— replace <code className="bg-blue-900/40 px-1 rounded font-mono">ACCT_ID</code> with the account ID for sticky sessions.
      </div>

      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900">
              {["Label", "URL", "Zone", "Status", "Accounts", "Last Check", "Actions"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
            ) : proxies.map((p) => (
              <tr key={p.id} className="hover:bg-gray-900/40">
                <td className="px-4 py-3">{p.label ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-400 max-w-[200px] truncate">{p.url}</td>
                <td className="px-4 py-3 text-gray-500">{p.zone ?? "—"}</td>
                <td className="px-4 py-3">
                  {p.status === "ACTIVE"
                    ? <span className="flex items-center gap-1 text-green-400 text-xs"><CheckCircle className="w-3 h-3" /> Active</span>
                    : <span className="flex items-center gap-1 text-red-400 text-xs"><XCircle className="w-3 h-3" /> Dead</span>
                  }
                </td>
                <td className="px-4 py-3 text-gray-400">{p._count?.accounts ?? 0}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {p.lastChecked ? new Date(p.lastChecked).toLocaleTimeString() : "Never"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => healthCheck.mutate(p.id)} className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400">
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => delProxy.mutate(p.id)} className="p-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {proxies.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-600">No proxies configured</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold mb-4">Add Proxy</h2>
            <form onSubmit={(e) => { e.preventDefault(); addProxy.mutate(form); }} className="space-y-3">
              {[
                { label: "Proxy URL", key: "url", placeholder: "http://user:pass@host:port" },
                { label: "Zone (optional)", key: "zone", placeholder: "residential" },
                { label: "Label (optional)", key: "label", placeholder: "Account 1 proxy" },
              ].map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input
                    placeholder={placeholder}
                    value={(form as Record<string, string>)[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    required={key === "url"}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500 font-mono"
                  />
                </div>
              ))}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowAdd(false)} className="flex-1 py-2 rounded-lg border border-gray-700 text-sm hover:bg-gray-800">Cancel</button>
                <button type="submit" disabled={addProxy.isPending} className="flex-1 py-2 rounded-lg bg-brand-500 text-black font-medium text-sm hover:bg-brand-600">
                  {addProxy.isPending ? "Adding..." : "Add Proxy"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
