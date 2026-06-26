import React, { useState, useEffect, useRef, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { createAccount, updateAccount, fetchProxies, type Account } from "../lib/api";

// ── Job catalog ───────────────────────────────────────────────────────────────
export const JOBS_CA = [
  { jobId: "JOB-CA-0000000407", city: "Acheson",                prov: "AB", site: "YEG2" },
  { jobId: "JOB-CA-0000000472", city: "Acheson",                prov: "AB", site: "YEG4" },
  { jobId: "JOB-CA-0000000439", city: "Balzac",                 prov: "AB", site: "DCG2" },
  { jobId: "JOB-CA-0000000438", city: "Calgary",                prov: "AB", site: "DCG4" },
  { jobId: "JOB-CA-0000000442", city: "Calgary",                prov: "AB", site: "HYC2" },
  { jobId: "JOB-CA-0000000485", city: "Calgary",                prov: "AB", site: "YYC1" },
  { jobId: "JOB-CA-0000000441", city: "Calgary",                prov: "AB", site: "YYC4" },
  { jobId: "JOB-CA-0000000443", city: "Calgary",                prov: "AB", site: "YYC6" },
  { jobId: "JOB-CA-0000000468", city: "Calgary",                prov: "AB", site: "YYC8" },
  { jobId: "JOB-CA-0000000404", city: "Edmonton",               prov: "AB", site: "DYB3" },
  { jobId: "JOB-CA-0000000469", city: "Lethbridge",             prov: "AB", site: "XYC1" },
  { jobId: "JOB-CA-0000000406", city: "Nisku",                  prov: "AB", site: "DYB2" },
  { jobId: "JOB-CA-0000000448", city: "Nisku",                  prov: "AB", site: "HYE1" },
  { jobId: "JOB-CA-0000000405", city: "Nisku",                  prov: "AB", site: "YEG1" },
  { jobId: "JOB-CA-0000000440", city: "Rocky View County",      prov: "AB", site: "YYC5" },
  { jobId: "JOB-CA-0000000465", city: "Burnaby",                prov: "BC", site: "DVV2" },
  { jobId: "JOB-CA-0000000487", city: "Burnaby",                prov: "BC", site: "DVV5" },
  { jobId: "JOB-CA-0000000488", city: "Burnaby",                prov: "BC", site: "DVY9" },
  { jobId: "JOB-CA-0000000489", city: "Burnaby",                prov: "BC", site: "DYV2" },
  { jobId: "JOB-CA-0000000457", city: "Burnaby",                prov: "BC", site: "YDD3" },
  { jobId: "JOB-CA-0000000486", city: "Burnaby",                prov: "BC", site: "YVR6" },
  { jobId: "JOB-CA-0000000464", city: "Coquitlam",              prov: "BC", site: "HYV1" },
  { jobId: "JOB-CA-0000000458", city: "Delta",                  prov: "BC", site: "DYV1" },
  { jobId: "JOB-CA-0000000459", city: "Delta",                  prov: "BC", site: "YVR2" },
  { jobId: "JOB-CA-0000000456", city: "Kelowna",                prov: "BC", site: "WBC1" },
  { jobId: "JOB-CA-0000000460", city: "Langley",                prov: "BC", site: "DVY7" },
  { jobId: "JOB-CA-0000000452", city: "Langley",                prov: "BC", site: "YVR7" },
  { jobId: "JOB-CA-0000000462", city: "New Westminster",         prov: "BC", site: "YVR3" },
  { jobId: "JOB-CA-0000000453", city: "Pitt Meadows",           prov: "BC", site: "DVC4" },
  { jobId: "JOB-CA-0000000455", city: "Pitt Meadows",           prov: "BC", site: "YXX1" },
  { jobId: "JOB-CA-0000000454", city: "Richmond",               prov: "BC", site: "YXX2" },
  { jobId: "JOB-CA-0000000463", city: "Sidney",                 prov: "BC", site: "DVV2" },
  { jobId: "JOB-CA-0000000466", city: "Tsawwassen First Nation", prov: "BC", site: "YVR4" },
  { jobId: "JOB-CA-0000000403", city: "Winnipeg",               prov: "MB", site: "DMW1" },
  { jobId: "JOB-CA-0000000471", city: "Winnipeg",               prov: "MB", site: "DMW2" },
  { jobId: "JOB-CA-0000000402", city: "Dartmouth",              prov: "NS", site: "DYH1" },
  { jobId: "JOB-CA-0000000433", city: "Ajax",                   prov: "ON", site: "YOO1" },
  { jobId: "JOB-CA-0000000419", city: "Barrhaven",              prov: "ON", site: "YOW3" },
  { jobId: "JOB-CA-0000000449", city: "Belleville",             prov: "ON", site: "YGK1" },
  { jobId: "JOB-CA-0000000477", city: "Bolton",                 prov: "ON", site: "YHM8" },
  { jobId: "JOB-CA-0000000429", city: "Bolton",                 prov: "ON", site: "YYZ7" },
  { jobId: "JOB-CA-0000000478", city: "Bolton",                 prov: "ON", site: "YYZ8" },
  { jobId: "JOB-CA-0000000467", city: "Brampton",               prov: "ON", site: "CNC1" },
  { jobId: "JOB-CA-0000000426", city: "Brampton",               prov: "ON", site: "DOI3" },
  { jobId: "JOB-CA-0000000482", city: "Brampton",               prov: "ON", site: "VORF" },
  { jobId: "JOB-CA-0000000425", city: "Brampton",               prov: "ON", site: "YHM5" },
  { jobId: "JOB-CA-0000000450", city: "Brampton",               prov: "ON", site: "YKF1" },
  { jobId: "JOB-CA-0000000481", city: "Brampton",               prov: "ON", site: "YYZ3" },
  { jobId: "JOB-CA-0000000431", city: "Brampton",               prov: "ON", site: "YYZ4" },
  { jobId: "JOB-CA-0000000417", city: "Brantford",              prov: "ON", site: "VUCY" },
  { jobId: "JOB-CA-0000000414", city: "Cambridge",              prov: "ON", site: "DXT2" },
  { jobId: "JOB-CA-0000000410", city: "Cambridge",              prov: "ON", site: "YHM2" },
  { jobId: "JOB-CA-0000000422", city: "Concord",                prov: "ON", site: "DTO5" },
  { jobId: "JOB-CA-0000000418", city: "Cornwall",               prov: "ON", site: "XYT6" },
  { jobId: "JOB-CA-0000000476", city: "Etobicoke",              prov: "ON", site: "DTO3" },
  { jobId: "JOB-CA-0000000286", city: "Etobicoke",              prov: "ON", site: "DON9" },
  { jobId: "JOB-CA-0000000413", city: "Hamilton",               prov: "ON", site: "YHM1" },
  { jobId: "JOB-CA-0000000412", city: "Kitchener",              prov: "ON", site: "DTY7" },
  { jobId: "JOB-CA-0000000416", city: "London",                 prov: "ON", site: "DLC1" },
  { jobId: "JOB-CA-0000000473", city: "London",                 prov: "ON", site: "DLC4" },
  { jobId: "JOB-CA-0000000430", city: "Mississauga",            prov: "ON", site: "DOI5" },
  { jobId: "JOB-CA-0000000479", city: "Mississauga",            prov: "ON", site: "DOI6" },
  { jobId: "JOB-CA-0000000480", city: "Mississauga",            prov: "ON", site: "DTY4" },
  { jobId: "JOB-CA-0000000424", city: "Mississauga",            prov: "ON", site: "YYZ1" },
  { jobId: "JOB-CA-0000000427", city: "Milton",                 prov: "ON", site: "VOPC" },
  { jobId: "JOB-CA-0000000475", city: "Milton",                 prov: "ON", site: "YYZ2" },
  { jobId: "JOB-CA-0000000423", city: "Oakville",               prov: "ON", site: "DTO8" },
  { jobId: "JOB-CA-0000000446", city: "Oakville",               prov: "ON", site: "HYZ1" },
  { jobId: "JOB-CA-0000000420", city: "Ottawa",                 prov: "ON", site: "DYT3" },
  { jobId: "JOB-CA-0000000474", city: "Ottawa",                 prov: "ON", site: "DYT6" },
  { jobId: "JOB-CA-0000000447", city: "Ottawa",                 prov: "ON", site: "HYO1" },
  { jobId: "JOB-CA-0000000400", city: "Ottawa",                 prov: "ON", site: "YOW1" },
  { jobId: "JOB-CA-0000000451", city: "Owen Sound",             prov: "ON", site: "XIO3" },
  { jobId: "JOB-CA-0000000470", city: "Owen Sound",             prov: "ON", site: "XOI3" },
  { jobId: "JOB-CA-0000000432", city: "Richmond Hill",          prov: "ON", site: "DOI4" },
  { jobId: "JOB-CA-0000000408", city: "Sarnia",                 prov: "ON", site: "XLC1" },
  { jobId: "JOB-CA-0000000437", city: "Scarborough",            prov: "ON", site: "DOI2" },
  { jobId: "JOB-CA-0000000484", city: "Scarborough",            prov: "ON", site: "DTO1" },
  { jobId: "JOB-CA-0000000436", city: "Scarborough",            prov: "ON", site: "YYZ9" },
  { jobId: "JOB-CA-0000000483", city: "Scarborough",            prov: "ON", site: "DON8" },
  { jobId: "JOB-CA-0000000415", city: "ST. Thomas",             prov: "ON", site: "YXU1" },
  { jobId: "JOB-CA-0000000411", city: "Stoney Creek",           prov: "ON", site: "DXT8" },
  { jobId: "JOB-CA-0000000444", city: "Toronto",                prov: "ON", site: "HYZ2" },
  { jobId: "JOB-CA-0000000445", city: "Toronto",                prov: "ON", site: "HYZ2" },
  { jobId: "JOB-CA-0000000434", city: "Whitby",                 prov: "ON", site: "YHM6" },
  { jobId: "JOB-CA-0000000409", city: "Windsor",                prov: "ON", site: "DLC8" },
  { jobId: "JOB-CA-0000000401", city: "Laval",                  prov: "QC", site: "DYT4" },
] as const;

export const JOBS_US = [
  { jobId: "JOB-US-0000015281", city: "Vacaville",     state: "CA", site: "APC2" },
  { jobId: "JOB-US-0000017091", city: "Gypsum",        state: "CO", site: "WOL1" },
  { jobId: "JOB-US-0000017009", city: "Sterling",      state: "CO", site: "WCO9" },
  { jobId: "JOB-US-0000010999", city: "Riviera Beach", state: "FL", site: "SFL6" },
  { jobId: "JOB-US-0000012423", city: "Mason City",    state: "IA", site: "WIO2" },
  { jobId: "JOB-US-0000015154", city: "Hyannis",       state: "MA", site: "LHYC" },
  { jobId: "JOB-US-0000015169", city: "Portland",      state: "ME", site: "LPTL" },
  { jobId: "JOB-US-0000013077", city: "Duluth",        state: "MN", site: "WMN3" },
  { jobId: "JOB-US-0000016567", city: "North Mankato", state: "MN", site: "WMN7" },
  { jobId: "JOB-US-0000013051", city: "Belgrade",      state: "MT", site: "WMT2" },
  { jobId: "JOB-US-0000015323", city: "Kalispell",     state: "MT", site: "WMT4" },
  { jobId: "JOB-US-0000015325", city: "Columbus",      state: "NE", site: "WNB5" },
  { jobId: "JOB-US-0000010681", city: "Grand Island",  state: "NE", site: "WNB2" },
  { jobId: "JOB-US-0000015381", city: "Santa Fe",      state: "NM", site: "WNM2" },
  { jobId: "JOB-US-0000012307", city: "Reno",          state: "NV", site: "DLV3" },
  { jobId: "JOB-US-0000017229", city: "Wells",         state: "NV", site: "WNV2" },
  { jobId: "JOB-US-0000012157", city: "Bath",          state: "NY", site: "WNY2" },
  { jobId: "JOB-US-0000010301", city: "Granville",     state: "NY", site: "WNY4" },
  { jobId: "JOB-US-0000014730", city: "Asheville",     state: "NC", site: "LASH" },
  { jobId: "JOB-US-0000016570", city: "Bellefonte",    state: "PA", site: "WPY1" },
  { jobId: "JOB-US-0000015060", city: "Tremont",       state: "PA", site: "QYY4" },
  { jobId: "JOB-US-0000013080", city: "Summerville",   state: "SC", site: "SSC4" },
  { jobId: "JOB-US-0000015198", city: "San Angelo",    state: "TX", site: "WTX9" },
  { jobId: "JOB-US-0000017119", city: "Saint George",  state: "UT", site: "WUT1" },
] as const;

type JobCA = typeof JOBS_CA[number];
type JobUS = typeof JOBS_US[number];
type AnyJob = JobCA | JobUS;

function jobRegion(j: AnyJob) { return "prov" in j ? j.prov : j.state; }

// ── JobSelector ───────────────────────────────────────────────────────────────
export function JobSelector({
  country,
  value,
  onChange,
  resetOnCountryChange = true,
}: {
  country: string;
  value: string[];
  onChange: (ids: string[]) => void;
  resetOnCountryChange?: boolean;
}) {
  const jobs: readonly AnyJob[] = country === "CA" ? JOBS_CA : JOBS_US;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const lower = search.toLowerCase();
    const filtered = search
      ? jobs.filter(j =>
          j.city.toLowerCase().includes(lower) ||
          jobRegion(j).toLowerCase().includes(lower) ||
          j.site.toLowerCase().includes(lower) ||
          j.jobId.includes(search)
        )
      : jobs;
    const map: Record<string, AnyJob[]> = {};
    filtered.forEach(j => { const k = jobRegion(j); (map[k] ??= []).push(j); });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [jobs, search]);

  const allIds = jobs.map(j => j.jobId) as string[];
  const allSelected = value.length === allIds.length;
  const someSelected = value.length > 0 && !allSelected;

  const toggleAll = () => onChange(allSelected ? [] : [...allIds]);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter(i => i !== id) : [...value, id]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (resetOnCountryChange) onChange([]);
  }, [country]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-left flex items-center justify-between focus:outline-none focus:border-gray-500"
      >
        <span className={value.length ? "text-white" : "text-gray-500"}>
          {value.length === 0
            ? "Select jobs to monitor..."
            : value.length === allIds.length
            ? `All ${allIds.length} jobs selected`
            : `${value.length} of ${allIds.length} jobs selected`}
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="p-2 border-b border-gray-700">
            <input
              autoFocus
              type="text"
              placeholder="Search city, province, site..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-gray-500 placeholder:text-gray-600"
            />
          </div>
          <label className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-700 cursor-pointer border-b border-gray-700 bg-gray-800 sticky top-0">
            <input
              type="checkbox"
              checked={allSelected}
              ref={el => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
              className="accent-green-500 w-3.5 h-3.5"
            />
            <span className="text-xs font-semibold text-gray-200">
              Select All ({country}) — {allIds.length} locations
            </span>
          </label>
          <div className="max-h-52 overflow-y-auto">
            {grouped.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-4">No results</p>
            ) : grouped.map(([region, items]) => (
              <div key={region}>
                <div className="px-3 py-1 text-[10px] font-bold text-gray-500 uppercase tracking-widest bg-gray-900/60 sticky top-0">
                  {region}
                </div>
                {items.map(j => {
                  const id = j.jobId;
                  const suffix = id.split("-").pop()!.replace(/^0+/, "") || "0";
                  const checked = value.includes(id);
                  return (
                    <label key={id} className={`flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-700 cursor-pointer ${checked ? "bg-gray-750" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(id)}
                        className="accent-green-500 w-3.5 h-3.5 shrink-0"
                      />
                      <span className="text-xs text-gray-300 min-w-0">
                        {j.city}, <span className="text-gray-400">{jobRegion(j)}</span>
                        {" — "}<span className="font-mono text-green-400">{j.site}</span>
                        <span className="text-gray-600 ml-1.5">#{suffix}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
          {value.length > 0 && (
            <div className="px-3 py-2 border-t border-gray-700 flex items-center justify-between bg-gray-900">
              <span className="text-xs text-gray-400">{value.length} selected</span>
              <button type="button" onClick={() => onChange([])} className="text-xs text-gray-500 hover:text-red-400">
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AccountModal (add + edit) ─────────────────────────────────────────────────
interface AccountModalProps {
  account?: Account; // provided → edit mode
  onClose: () => void;
}

export function AccountModal({ account, onClose }: AccountModalProps) {
  const qc = useQueryClient();
  const { data: proxies = [] } = useQuery({ queryKey: ["proxies"], queryFn: fetchProxies });
  const isEdit = !!account;

  const [form, setForm] = useState({
    email:          account?.email          ?? "",
    pin:            account?.pin            ?? "",
    country:        account?.country        ?? "CA",
    selectedJobIds: account?.jobIds         ?? [] as string[],
    proxyId:        account?.proxyId        ?? "",
    notes:          account?.notes          ?? "",
  });

  const createMut = useMutation({
    mutationFn: (data: Parameters<typeof createAccount>[0]) => createAccount(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
  });

  const updateMut = useMutation({
    mutationFn: (data: Parameters<typeof updateAccount>[1]) => updateAccount(account!.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts"] }); onClose(); },
  });

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error || updateMut.error;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      email:   form.email,
      pin:     form.pin,
      country: form.country,
      jobIds:  form.selectedJobIds,
      proxyId: form.proxyId || undefined,
      notes:   form.notes   || undefined,
    };
    if (isEdit) updateMut.mutate(payload);
    else createMut.mutate(payload as Parameters<typeof createAccount>[0]);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 rounded-xl border border-gray-700 p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{isEdit ? "Edit Account" : "Add Account"}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-800 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-950 border border-red-800 rounded-lg px-3 py-2 mb-3">
            {String(error)}
          </p>
        )}

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Email</label>
            <input
              type="email"
              placeholder="user@gmail.com"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">
              PIN (6 digits){isEdit && <span className="text-gray-600 ml-1">— leave unchanged to keep current</span>}
            </label>
            <input
              type="password"
              placeholder={isEdit ? "••••••  (unchanged)" : "123456"}
              value={form.pin}
              onChange={e => setForm(f => ({ ...f, pin: e.target.value }))}
              required={!isEdit}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Country</label>
            <select
              value={form.country}
              onChange={e => setForm(f => ({ ...f, country: e.target.value as "CA" | "US", selectedJobIds: [] }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            >
              <option value="CA">Canada</option>
              <option value="US">United States</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Jobs to Monitor</label>
            <JobSelector
              country={form.country}
              value={form.selectedJobIds}
              onChange={ids => setForm(f => ({ ...f, selectedJobIds: ids }))}
              resetOnCountryChange={false}
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Proxy</label>
            <select
              value={form.proxyId}
              onChange={e => setForm(f => ({ ...f, proxyId: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">No proxy</option>
              {proxies.map(p => (
                <option key={p.id} value={p.id}>{p.label ?? p.url}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1">Notes</label>
            <input
              type="text"
              placeholder="Optional"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-gray-700 text-sm hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || form.selectedJobIds.length === 0}
              className="flex-1 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium text-sm disabled:opacity-50"
            >
              {isPending
                ? (isEdit ? "Saving..." : "Adding...")
                : isEdit
                ? "Save Changes"
                : `Add Account (${form.selectedJobIds.length} jobs)`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
