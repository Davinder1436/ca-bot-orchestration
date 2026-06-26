import axios from "axios";

export const api = axios.create({ baseURL: "/api" });

export interface Account {
  id: string;
  email: string;
  pin: string;
  country: "CA" | "US";
  status: string;
  jobIds: string[];
  proxyId?: string;
  proxy?: Proxy;
  notes?: string;
  lastLoginAt?: string;
  createdAt: string;
  _count?: { captures: number };
}

export interface Proxy {
  id: string;
  url: string;
  zone?: string;
  label?: string;
  status: string;
  lastChecked?: string;
  failCount: number;
  _count?: { accounts: number };
}

export interface JobCapture {
  id: string;
  accountId: string;
  jobId: string;
  scheduleId: string;
  jobTitle?: string;
  location?: string;
  applyUrl?: string;
  status: string;
  capturedAt: string;
  account?: { email: string; country: string };
}

export interface BusEvent {
  type: string;
  accountId?: string;
  payload: Record<string, unknown>;
  ts: number;
}

// Accounts
export const fetchAccounts = () => api.get<Account[]>("/accounts").then((r) => r.data);
export const createAccount = (data: Partial<Account>) => api.post<Account>("/accounts", data).then((r) => r.data);
export const updateAccount = (id: string, data: Partial<Account>) => api.patch<Account>(`/accounts/${id}`, data).then((r) => r.data);
export const deleteAccount = (id: string) => api.delete(`/accounts/${id}`);

// Workers
export const startWorker = (accountId: string) => api.post(`/workers/${accountId}/start`).then((r) => r.data);
export const stopWorker = (accountId: string) => api.post(`/workers/${accountId}/stop`).then((r) => r.data);
export const fetchRunningWorkers = () => api.get<{ running: string[] }>("/workers").then((r) => r.data);

// Proxies
export const fetchProxies = () => api.get<Proxy[]>("/proxies").then((r) => r.data);
export const createProxy = (data: Partial<Proxy>) => api.post<Proxy>("/proxies", data).then((r) => r.data);
export const deleteProxy = (id: string) => api.delete(`/proxies/${id}`);
export const checkProxy = (id: string) => api.post<{ healthy: boolean }>(`/proxies/${id}/check`).then((r) => r.data);

// Jobs
export const fetchJobs = (params?: { accountId?: string; limit?: number }) =>
  api.get<JobCapture[]>("/jobs", { params }).then((r) => r.data);

// Events
export const fetchEvents = (params?: { type?: string; limit?: number }) =>
  api.get<BusEvent[]>("/events", { params }).then((r) => r.data);

// Worker details
export interface WorkerSession {
  id: string;
  accountId: string;
  containerId?: string;
  status: string;
  startedAt: string;
  lastHeartbeat?: string;
  endedAt?: string;
  errorMessage?: string;
}

export interface WorkerDetails {
  account: Account & { _count: { captures: number } };
  containerId: string | null;
  sessions: WorkerSession[];
  recentEvents: (BusEvent & { id: string; createdAt: string })[];
}

export const fetchWorkerDetails = (accountId: string) =>
  api.get<WorkerDetails>(`/workers/${accountId}/details`).then((r) => r.data);
