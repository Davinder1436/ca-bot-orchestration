import React from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAccounts, fetchJobs } from "../lib/api";
import { WorkerCard } from "../components/WorkerCard";
import { useWorkerStates } from "../lib/socket";
import { CheckCircle, Users, Zap, TrendingUp } from "lucide-react";

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: React.ComponentType<{className?: string}>; color: string }) {
  return (
    <div className={`rounded-xl border p-4 ${color}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wide opacity-60">{label}</span>
        <Icon className="w-4 h-4 opacity-60" />
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

export function Overview() {
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: fetchAccounts });
  const { data: jobs = [] } = useQuery({ queryKey: ["jobs"], queryFn: () => fetchJobs({ limit: 100 }) });
  const liveStates = useWorkerStates();

  const running = accounts.filter((a) => {
    const s = liveStates[a.id] ?? a.status;
    return ["RUNNING", "POLLING", "STARTING", "LOGGING_IN", "APPLYING"].includes(s);
  }).length;

  const today = new Date().toDateString();
  const todayJobs = jobs.filter((j) => new Date(j.capturedAt).toDateString() === today).length;

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-6">Overview</h1>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Accounts" value={accounts.length} icon={Users} color="bg-gray-900 border-gray-700" />
        <StatCard label="Workers Running" value={running} icon={Zap} color="bg-green-950 border-green-800" />
        <StatCard label="Jobs Today" value={todayJobs} icon={TrendingUp} color="bg-blue-950 border-blue-800" />
        <StatCard label="Total Captured" value={jobs.length} icon={CheckCircle} color="bg-purple-950 border-purple-800" />
      </div>

      {/* Worker grid */}
      <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Workers</h2>
      {accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-700 p-12 text-center text-gray-500">
          No accounts yet. Add one in the Accounts tab.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {accounts.map((a) => (
            <WorkerCard key={a.id} account={a} liveStatus={liveStates[a.id]} />
          ))}
        </div>
      )}
    </div>
  );
}
