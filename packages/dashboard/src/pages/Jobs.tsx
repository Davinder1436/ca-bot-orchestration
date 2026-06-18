import React from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJobs } from "../lib/api";
import { ExternalLink } from "lucide-react";

export function Jobs() {
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => fetchJobs({ limit: 200 }),
  });

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-6">Captured Jobs ({jobs.length})</h1>
      <div className="rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900">
              {["Time", "Account", "Job Title", "Location", "Schedule ID", "Status", "Link"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs text-gray-500 font-medium uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {isLoading ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Loading...</td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-600">No jobs captured yet</td></tr>
            ) : jobs.map((j) => (
              <tr key={j.id} className="hover:bg-gray-900/40">
                <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                  {new Date(j.capturedAt).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{j.account?.email ?? j.accountId.slice(0, 8)}</td>
                <td className="px-4 py-3">{j.jobTitle ?? "—"}</td>
                <td className="px-4 py-3 text-gray-400">{j.location ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs text-gray-500">{j.scheduleId.slice(0, 12)}...</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${j.status === "APPLIED" ? "bg-green-900 text-green-300" : "bg-gray-800 text-gray-400"}`}>
                    {j.status}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {j.applyUrl && (
                    <a href={j.applyUrl} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-gray-800 inline-block text-gray-400 hover:text-white">
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
