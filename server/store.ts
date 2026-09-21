/**
 * Process-wide state.
 *
 * This is the closest thing the application has to a database, and it is
 * deliberately just two Maps in memory: scan results (a cache that can always
 * be rebuilt by re-scanning) and running jobs (which only matter while the
 * process is alive). Everything that must survive a restart is written to
 * `degraded_output/` as JSON/CSV by metadata.service.
 *
 * The maps hang off globalThis so Next.js module reloading in dev does not
 * silently create a second, empty store while a job is still running.
 */

import { randomUUID } from 'node:crypto';
import type { DatasetScan, JobRequest } from '@/types';
import { scanDataset } from '@/services/scanner.service';
import { planTasks } from '@/services/planner.service';
import { Job } from '@/services/processing.service';
import { normalize } from '@/utils/paths';

interface Store {
  scans: Map<string, DatasetScan>;
  jobs: Map<string, Job>;
  jobOrder: string[];
  /** Output roots this session has written to, for the media endpoint. */
  outputRoots: Set<string>;
}

const globalRef = globalThis as typeof globalThis & { __degradationStore?: Store };

const store: Store =
  globalRef.__degradationStore ??
  (globalRef.__degradationStore = {
    scans: new Map(),
    jobs: new Map(),
    jobOrder: [],
    outputRoots: new Set(),
  });

/* -------------------------------------------------------------------------- */
/* Scans                                                                      */
/* -------------------------------------------------------------------------- */

export function putScan(scan: DatasetScan): void {
  store.scans.set(normalize(scan.root), scan);
}

export function peekScan(root: string): DatasetScan | null {
  return store.scans.get(normalize(root)) ?? null;
}

/**
 * Return a cached scan, scanning on demand when the cache is cold. Keeping the
 * heavy `videos` array on the server means the browser only ever exchanges root
 * paths with the API, not megabytes of per-file metadata.
 */
export async function getScan(root: string, force = false): Promise<DatasetScan> {
  const key = normalize(root);
  if (!force) {
    const cached = store.scans.get(key);
    if (cached) return cached;
  }
  const scan = await scanDataset(key);
  store.scans.set(key, scan);
  return scan;
}

export function listScans(): DatasetScan[] {
  return [...store.scans.values()];
}

export function dropScan(root: string): void {
  store.scans.delete(normalize(root));
}

/* -------------------------------------------------------------------------- */
/* Servable output roots                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Record an output root so /api/media may serve preview clips from it.
 *
 * With the default layout the output lives inside a scanned dataset, which the
 * media route already allows. A custom output root is somewhere else entirely,
 * so it has to be registered explicitly - the endpoint refuses anything that is
 * not on this list, which keeps a guessed path from reading arbitrary files.
 */
export function registerOutputRoot(root: string): void {
  store.outputRoots.add(normalize(root));
}

export function listOutputRoots(): string[] {
  return [...store.outputRoots];
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/** Keep a bounded history so a long-lived process does not grow without end. */
const MAX_JOB_HISTORY = 20;

export async function createJob(request: JobRequest): Promise<{ job: Job; taskCount: number }> {
  const scans = await Promise.all(request.roots.map((root) => getScan(root)));
  const plan = planTasks(request, scans);

  for (const outputRoot of plan.outputRootByRoot.values()) registerOutputRoot(outputRoot);

  const id = randomUUID().slice(0, 8);
  const job = new Job(id, request, scans, plan);

  store.jobs.set(id, job);
  store.jobOrder.push(id);

  // Evict the oldest *finished* jobs once the history is full.
  while (store.jobOrder.length > MAX_JOB_HISTORY) {
    const oldestId = store.jobOrder.find((candidate) => {
      const candidateJob = store.jobs.get(candidate);
      if (!candidateJob) return true;
      const status = candidateJob.getStatus();
      return status === 'completed' || status === 'cancelled' || status === 'failed';
    });
    if (!oldestId) break;
    store.jobs.delete(oldestId);
    store.jobOrder = store.jobOrder.filter((candidate) => candidate !== oldestId);
  }

  return { job, taskCount: plan.tasks.length };
}

export function getJob(id: string): Job | null {
  return store.jobs.get(id) ?? null;
}

export function listJobs(): Job[] {
  return store.jobOrder
    .map((id) => store.jobs.get(id))
    .filter((job): job is Job => job !== undefined)
    .reverse();
}

/** The job currently occupying the machine, if any. */
export function activeJob(): Job | null {
  for (const job of listJobs()) {
    const status = job.getStatus();
    if (status === 'running' || status === 'paused') return job;
  }
  return null;
}
