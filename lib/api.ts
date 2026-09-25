/**
 * Typed fetch wrappers for the local API.
 *
 * Every call here goes to this application's own server on localhost. No
 * request in this file (or anywhere else in the project) reaches the internet.
 */

import type {
  DirListing,
  DiskInfo,
  Estimate,
  JobRequest,
  JobSnapshot,
  LogEntry,
  PreviewClip,
  ScanSummary,
  SystemInfo,
  TaskStatus,
  VideoMetadata,
} from '@/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export function getSystem(refresh = false): Promise<SystemInfo> {
  return request<SystemInfo>(`/api/system${refresh ? '?refresh=1' : ''}`);
}

export function getDisks(paths: string[]): Promise<{ disks: DiskInfo[] }> {
  if (paths.length === 0) return Promise.resolve({ disks: [] });
  return request(`/api/system/disk?path=${encodeURIComponent(paths.join('|'))}`);
}

/* -------------------------------------------------------------------------- */
/* Filesystem browsing                                                        */
/* -------------------------------------------------------------------------- */

export function listDir(path?: string): Promise<DirListing & { videoFilesHere: number }> {
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/api/fs/list${query}`);
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

export interface ScanResponse {
  root: string;
  name: string;
  scannedAt: string;
  summary: ScanSummary;
  hasExistingOutput: boolean;
  cached: boolean;
  disk: DiskInfo;
  videos: VideoMetadata[];
  videoCount: number;
  truncated: boolean;
}

export function scanFolder(root: string, force: boolean, token: string): Promise<ScanResponse> {
  return request('/api/scan', {
    method: 'POST',
    body: JSON.stringify({ root, force, token }),
  });
}

export interface ScanProgressResponse {
  progress: {
    phase: 'walking' | 'probing' | 'done' | 'error';
    found: number;
    probed: number;
    current: string;
    error?: string;
  } | null;
}

export function getScanProgress(token: string): Promise<ScanProgressResponse> {
  return request(`/api/scan/progress?token=${encodeURIComponent(token)}`);
}

/* -------------------------------------------------------------------------- */
/* Estimate                                                                   */
/* -------------------------------------------------------------------------- */

export interface OutputProblem {
  code: 'inside-input' | 'contains-input' | 'same-as-input' | 'name-collision';
  message: string;
}

export interface EstimateResponse {
  estimate: Estimate;
  /** Absolute output roots, one per dataset, as the server resolved them. */
  outputRoots: string[];
  /** Set when the chosen output folder would break a later run. */
  outputProblem: OutputProblem | null;
  disks: DiskInfo[];
  totalTasks: number;
  skippedTasks: number;
  skippedReasons: string[];
  diskStatus: 'READY' | 'TIGHT' | 'INSUFFICIENT' | 'UNKNOWN';
  freeBytes: number;
}

export function getEstimate(payload: JobRequest): Promise<EstimateResponse> {
  return request('/api/estimate', { method: 'POST', body: JSON.stringify(payload) });
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export interface PreviewResponse {
  clips: PreviewClip[];
  video: string;
  seconds: number;
}

export function generatePreview(payload: unknown): Promise<PreviewResponse> {
  return request('/api/preview', { method: 'POST', body: JSON.stringify(payload) });
}

export function clearPreviews(
  root: string,
  outputRoot?: string | null,
): Promise<{ cleared: boolean }> {
  const params = new URLSearchParams({ root });
  if (outputRoot) params.set('outputRoot', outputRoot);
  return request(`/api/preview?${params.toString()}`, { method: 'DELETE' });
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export interface StartJobResponse {
  jobId: string;
  taskCount: number;
  snapshot: JobSnapshot;
}

export function startJob(payload: JobRequest): Promise<StartJobResponse> {
  return request('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
}

export function getJob(id: string): Promise<{ snapshot: JobSnapshot; logs: LogEntry[] }> {
  return request(`/api/jobs/${id}`);
}

export function listJobs(): Promise<{ jobs: JobSnapshot[] }> {
  return request('/api/jobs');
}

export type ControlAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry-failed'
  | 'force-reprocess'
  | 'export'
  | 'skip-thermal-rest';

export function controlJob(
  id: string,
  action: ControlAction,
): Promise<{ snapshot: JobSnapshot; requeued?: number; files?: string[] }> {
  return request(`/api/jobs/${id}/control`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export interface TaskRow {
  id: string;
  datasetName: string;
  sourceRelative: string;
  outputRelative: string;
  degradation: string;
  level: string;
  severity: string | null;
  status: TaskStatus;
  progress: number;
  error: string | null;
  skipReason: string | null;
  processingMs: number | null;
  outputSizeBytes: number | null;
  sourceSha256: string | null;
  outputSha256: string | null;
  filterChain: string;
  params: Record<string, unknown>;
}

export function getTasks(
  id: string,
  opts: { status?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<{ tasks: TaskRow[]; total: number; offset: number; limit: number }> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.q) params.set('q', opts.q);
  params.set('limit', String(opts.limit ?? 100));
  params.set('offset', String(opts.offset ?? 0));
  return request(`/api/jobs/${id}/tasks?${params.toString()}`);
}

/** Open an SSE connection for a job. Returns a cleanup function. */
export function subscribeToJob(
  id: string,
  handlers: {
    onSnapshot?: (snapshot: JobSnapshot) => void;
    onLog?: (entry: LogEntry) => void;
    onLogs?: (entries: LogEntry[]) => void;
    onDone?: (snapshot: JobSnapshot) => void;
    onError?: () => void;
  },
): () => void {
  const source = new EventSource(`/api/jobs/${id}/events`);

  const parse = <T,>(event: MessageEvent): T | null => {
    try {
      return JSON.parse(event.data) as T;
    } catch {
      return null;
    }
  };

  source.addEventListener('snapshot', (event) => {
    const data = parse<JobSnapshot>(event as MessageEvent);
    if (data) handlers.onSnapshot?.(data);
  });
  source.addEventListener('log', (event) => {
    const data = parse<LogEntry>(event as MessageEvent);
    if (data) handlers.onLog?.(data);
  });
  source.addEventListener('logs', (event) => {
    const data = parse<LogEntry[]>(event as MessageEvent);
    if (data) handlers.onLogs?.(data);
  });
  source.addEventListener('done', (event) => {
    const data = parse<JobSnapshot>(event as MessageEvent);
    if (data) handlers.onDone?.(data);
    source.close();
  });
  source.onerror = () => {
    handlers.onError?.();
  };

  return () => source.close();
}
