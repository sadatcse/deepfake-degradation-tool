/**
 * The bulk processing engine.
 *
 * A job owns a flat list of tasks and a fixed pool of workers. Each worker
 * pulls the next pending task and runs one ffmpeg process against it, so the
 * number of concurrent encodes never exceeds what the operator configured, no
 * matter how many videos are queued.
 *
 * Failure of one task never stops the batch: it is recorded and the worker
 * moves on. Output is written to a `.part` file and renamed only after ffmpeg
 * exits cleanly, which is what makes "skip existing" safe to trust on resume -
 * a file that exists is a file that finished.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type {
  ActiveTaskView,
  DatasetScan,
  JobCounts,
  JobRequest,
  JobSnapshot,
  JobStatus,
  LogEntry,
  MetadataRecord,
  TaskRecord,
  TaskStatus,
} from '@/types';
import { Gate } from '@/utils/concurrency';
import { PARTIAL_SUFFIX, assertInside, resolveOutputRoot } from '@/utils/paths';
import { buildEncodeArgs, requireFfmpeg, runFfmpeg, FfmpegError } from './ffmpeg.service';
import { sha256Cached } from './checksum.service';
import {
  ensureOutputDir,
  mergeMetadata,
  prepareOutputFolders,
  readMetadataIndex,
  writeManifest,
  writeMetadataCsv,
  writeOutputReadme,
  writeProcessingLog,
} from './metadata.service';
import type { PlanResult } from './planner.service';

const MAX_UI_LOG_ENTRIES = 2000;
const SNAPSHOT_THROTTLE_MS = 250;
const FLUSH_EVERY_N = 25;
const FLUSH_EVERY_MS = 10_000;

export interface JobEvents {
  snapshot: (snapshot: JobSnapshot) => void;
  log: (entry: LogEntry) => void;
  done: (snapshot: JobSnapshot) => void;
}

export class Job {
  readonly id: string;
  readonly request: JobRequest;
  readonly createdAt = new Date().toISOString();

  private readonly tasks: TaskRecord[];
  private readonly scans: DatasetScan[];
  private readonly plan: PlanResult;
  private readonly emitter = new EventEmitter();
  private readonly gate = new Gate();

  private status: JobStatus = 'idle';
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private cursor = 0;
  private cancelled = false;
  private running = false;

  private readonly controllers = new Map<string, AbortController>();
  private readonly activeSpeed = new Map<string, string | null>();
  private logs: LogEntry[] = [];
  private pendingLogLines: string[] = [];

  /** Metadata not yet written to disk, grouped by dataset root. */
  private readonly pendingRecords = new Map<string, MetadataRecord[]>();
  /** Every record produced this run, used for the manifest. */
  private readonly allRecords = new Map<string, MetadataRecord[]>();
  private sinceFlush = 0;
  private lastFlush = Date.now();
  private flushChain: Promise<void> = Promise.resolve();

  private lastSnapshotAt = 0;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private ranTasks = 0;
  private outputBytes = 0;

  constructor(id: string, request: JobRequest, scans: DatasetScan[], plan: PlanResult) {
    this.id = id;
    this.request = request;
    this.scans = scans;
    this.plan = plan;
    this.tasks = plan.tasks;
    // Nothing should be lost if a listener throws.
    this.emitter.setMaxListeners(64);
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                          */
  /* ---------------------------------------------------------------------- */

  getTasks(): readonly TaskRecord[] {
    return this.tasks;
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  getStatus(): JobStatus {
    return this.status;
  }

  /** The resolved output root for a dataset, as fixed at plan time. */
  private outputRootFor(datasetRoot: string): string {
    return (
      this.plan.outputRootByRoot.get(datasetRoot) ??
      resolveOutputRoot(datasetRoot, this.request.options.outputRoot)
    );
  }

  private counts(): JobCounts {
    const counts: JobCounts = {
      total: this.tasks.length,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    };
    for (const task of this.tasks) counts[task.status] += 1;
    return counts;
  }

  snapshot(): JobSnapshot {
    const counts = this.counts();
    const elapsedMs = this.startedAt
      ? (this.finishedAt ? Date.parse(this.finishedAt) : Date.now()) - Date.parse(this.startedAt)
      : 0;

    // Only tasks that actually ran predict how long the rest will take;
    // instant skips would make the estimate far too optimistic.
    const remaining = counts.pending + counts.running;
    const etaMs =
      this.ranTasks > 0 && remaining > 0 && this.status === 'running'
        ? Math.round((elapsedMs / this.ranTasks) * remaining)
        : null;

    const active: ActiveTaskView[] = [];
    for (const task of this.tasks) {
      if (task.status !== 'running') continue;
      active.push({
        taskId: task.id,
        sourceRelative: task.sourceRelative,
        degradation: task.degradation,
        level: task.level,
        severity: task.severity,
        progress: task.progress,
        speed: this.activeSpeed.get(task.id) ?? null,
      });
    }

    const datasets = this.scans.map((scan) => {
      let total = 0;
      let done = 0;
      for (const task of this.tasks) {
        if (task.root !== scan.root) continue;
        total += 1;
        if (
          task.status === 'completed' ||
          task.status === 'failed' ||
          task.status === 'skipped'
        ) {
          done += 1;
        }
      }
      return { root: scan.root, name: scan.name, total, done };
    });

    return {
      id: this.id,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      request: this.request,
      counts,
      active,
      outputBytes: this.outputBytes,
      elapsedMs,
      etaMs,
      datasets,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  on<K extends keyof JobEvents>(event: K, listener: JobEvents[K]): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  private log(level: LogEntry['level'], message: string, taskId?: string): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message, taskId };
    this.logs.push(entry);
    if (this.logs.length > MAX_UI_LOG_ENTRIES) {
      this.logs = this.logs.slice(-MAX_UI_LOG_ENTRIES);
    }
    this.pendingLogLines.push(`[${entry.ts}] ${level.toUpperCase().padEnd(7)} ${message}`);
    this.emitter.emit('log', entry);
  }

  /** Coalesce snapshot emissions so a 9000-task run does not flood the stream. */
  private pushSnapshot(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_THROTTLE_MS) {
      if (!this.snapshotTimer) {
        this.snapshotTimer = setTimeout(
          () => {
            this.snapshotTimer = null;
            this.pushSnapshot(true);
          },
          SNAPSHOT_THROTTLE_MS - (now - this.lastSnapshotAt),
        );
      }
      return;
    }
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.lastSnapshotAt = now;
    this.emitter.emit('snapshot', this.snapshot());
  }

  /* ---------------------------------------------------------------------- */
  /* Control                                                                */
  /* ---------------------------------------------------------------------- */

  pause(): void {
    if (this.status !== 'running') return;
    this.gate.close();
    this.status = 'paused';
    this.log('warn', 'Paused. Encodes already in flight will finish; no new ones will start.');
    this.pushSnapshot(true);
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this.gate.release();
    this.log('info', 'Resumed.');
    this.pushSnapshot(true);
  }

  cancel(): void {
    if (this.status === 'completed' || this.status === 'cancelled') return;
    this.cancelled = true;
    this.gate.release(); // let paused workers wake up and exit
    for (const controller of this.controllers.values()) controller.abort();
    this.log('warn', 'Cancelling. Active ffmpeg processes are being stopped.');
    this.pushSnapshot(true);
  }

  /** Requeue only the failed tasks (spec 24). */
  retryFailed(): number {
    let requeued = 0;
    for (const task of this.tasks) {
      if (task.status !== 'failed') continue;
      task.status = 'pending';
      task.error = null;
      task.progress = 0;
      task.startedAt = null;
      task.finishedAt = null;
      requeued += 1;
    }
    if (requeued > 0) {
      this.cursor = 0;
      this.cancelled = false;
      this.log('info', `Requeued ${requeued} failed task${requeued === 1 ? '' : 's'}.`);
    }
    return requeued;
  }

  /** Mark pending tasks as reprocessable, ignoring existing output. */
  forceReprocessAll(): void {
    this.request.options.forceReprocess = true;
    for (const task of this.tasks) {
      if (task.status === 'skipped' && task.skipReason?.startsWith('OUTPUT EXISTS')) {
        task.status = 'pending';
        task.skipReason = null;
      }
    }
    this.cursor = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                              */
  /* ---------------------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    this.status = 'running';
    this.startedAt ??= new Date().toISOString();
    this.finishedAt = null;
    this.gate.release();

    try {
      const ffmpegBin = await requireFfmpeg();

      for (const scan of this.scans) {
        const root = this.outputRootFor(scan.root);
        const folders = this.plan.foldersByRoot.get(scan.root) ?? new Set<string>();
        await prepareOutputFolders(root, [...folders]);
        await writeOutputReadme(root, scan.root);
      }

      const counts = this.counts();
      this.log(
        'info',
        `Starting: ${counts.total} task${counts.total === 1 ? '' : 's'} across ` +
          `${this.scans.length} dataset${this.scans.length === 1 ? '' : 's'}, ` +
          `${this.request.options.workers} worker${this.request.options.workers === 1 ? '' : 's'}.`,
      );
      this.pushSnapshot(true);

      const width = Math.max(1, this.request.options.workers);
      await Promise.all(
        Array.from({ length: width }, () => this.worker(ffmpegBin)),
      );
    } catch (error) {
      this.status = 'failed';
      this.log('error', `Job could not start: ${(error as Error).message}`);
    } finally {
      this.running = false;
      this.finishedAt = new Date().toISOString();

      if (this.status !== 'failed') {
        this.status = this.cancelled ? 'cancelled' : 'completed';
      }

      await this.flush(true).catch((error) => {
        this.log('error', `Could not write metadata: ${(error as Error).message}`);
      });
      await this.finalize().catch((error) => {
        this.log('error', `Could not write reports: ${(error as Error).message}`);
      });

      const counts = this.counts();
      this.log(
        this.status === 'completed' ? 'success' : 'warn',
        `${this.status === 'completed' ? 'Finished' : 'Stopped'}: ` +
          `${counts.completed} completed, ${counts.failed} failed, ${counts.skipped} skipped.`,
      );

      this.pushSnapshot(true);
      this.emitter.emit('done', this.snapshot());
      await this.drainLogFile();
    }
  }

  private nextTask(): TaskRecord | null {
    while (this.cursor < this.tasks.length) {
      const task = this.tasks[this.cursor];
      this.cursor += 1;
      if (task.status === 'pending') return task;
    }
    return null;
  }

  private async worker(ffmpegBin: string): Promise<void> {
    for (;;) {
      if (this.cancelled) return;
      await this.gate.wait();
      if (this.cancelled) return;

      const task = this.nextTask();
      if (!task) return;

      try {
        await this.runTask(ffmpegBin, task);
      } catch (error) {
        // A bug in our own code must not take the batch down.
        task.status = 'failed';
        task.error = (error as Error).message;
        task.finishedAt = new Date().toISOString();
        this.log('error', `${task.sourceRelative} -> ${task.outputRelative}: ${task.error}`, task.id);
      }

      await this.maybeFlush();
      this.pushSnapshot();
    }
  }

  private async runTask(ffmpegBin: string, task: TaskRecord): Promise<void> {
    const outRoot = task.outputRoot;

    // Defence in depth: never write outside this dataset's own output folder.
    assertInside(outRoot, task.outputPath, 'output file');

    const { options } = this.request;

    // ---- Skip existing output (spec 25 / resume, spec 36) -------------------
    if (!options.forceReprocess && options.skipExisting) {
      const existing = await fs.stat(task.outputPath).catch(() => null);
      if (existing && existing.isFile() && existing.size > 0) {
        const index = await this.metadataIndex(outRoot);
        const previous = index.get(task.outputRelative);

        if (previous && previous.level !== task.level) {
          // Same filename, different settings - almost always a naming collision
          // from an earlier single-severity run. Flag it instead of silently
          // treating the old file as this task's output.
          task.status = 'failed';
          task.error =
            `Output already exists but was produced at level "${previous.level}", not "${task.level}". ` +
            'Enable "Always include severity in filename", or use Force Reprocess to overwrite.';
          task.finishedAt = new Date().toISOString();
          this.log('error', `${task.outputRelative}: ${task.error}`, task.id);
          // Deliberately no metadata record: the file at that path was produced
          // by an earlier run at a different level, and it is still the truth
          // about that file. The failure is captured in processing_log.json.
          return;
        }

        task.status = 'skipped';
        task.skipReason = 'OUTPUT EXISTS';
        task.outputSizeBytes = existing.size;
        task.finishedAt = new Date().toISOString();
        this.log('info', `SKIPPED - OUTPUT EXISTS  ${task.outputRelative}`, task.id);
        this.pushSnapshot();
        return;
      }
    }

    // ---- Run ---------------------------------------------------------------
    task.status = 'running';
    task.attempts += 1;
    task.progress = 0;
    task.startedAt = new Date().toISOString();
    const startedMs = Date.now();
    this.log(
      'info',
      `Started ${task.sourceRelative}  [${task.degradation} / ${task.level}]`,
      task.id,
    );
    this.pushSnapshot();

    await ensureOutputDir(outRoot, task.outputPath);

    const partPath = `${task.outputPath}${PARTIAL_SUFFIX}.mp4`;
    await fs.rm(partPath, { force: true });

    const controller = new AbortController();
    this.controllers.set(task.id, controller);

    const args = await buildEncodeArgs({
      inputPath: task.sourcePath,
      outputPath: partPath,
      filters: task.exec.filters,
      extraArgs: task.exec.extraArgs,
      crf: task.exec.crf,
      preset: task.exec.preset,
      forceCfr: task.exec.forceCfr,
      outputFps: task.exec.outputFps ?? undefined,
      audioCodec: task.exec.audioCodec,
    });

    const duration = task.durationSec;

    try {
      await runFfmpeg(ffmpegBin, args, {
        signal: controller.signal,
        onProgress: (p) => {
          if (duration && duration > 0) {
            task.progress = Math.max(0, Math.min(1, p.outTimeSec / duration));
          }
          this.activeSpeed.set(task.id, p.speed);
          this.pushSnapshot();
        },
      });

      // ffmpeg exited 0 - promote the partial file to its real name.
      await fs.rm(task.outputPath, { force: true });
      await fs.rename(partPath, task.outputPath);

      const stat = await fs.stat(task.outputPath);
      if (stat.size === 0) throw new Error('ffmpeg produced an empty file.');

      task.outputSizeBytes = stat.size;
      this.outputBytes += stat.size;
      task.progress = 1;
      task.status = 'completed';
      task.processingMs = Date.now() - startedMs;
      task.finishedAt = new Date().toISOString();
      this.ranTasks += 1;

      if (options.computeChecksums) {
        task.sourceSha256 = await sha256Cached(task.sourcePath);
        task.outputSha256 = await sha256Cached(task.outputPath);
      }

      this.log(
        'success',
        `${task.degradation} completed  ${task.outputRelative}  ` +
          `(${(task.processingMs / 1000).toFixed(1)}s)`,
        task.id,
      );
      this.log('info', `Output validated  ${task.outputRelative}`, task.id);
      this.record(task);
    } catch (error) {
      await fs.rm(partPath, { force: true });

      const aborted = controller.signal.aborted;
      task.finishedAt = new Date().toISOString();
      task.processingMs = Date.now() - startedMs;

      if (aborted) {
        task.status = 'cancelled';
        task.error = 'Cancelled.';
        this.log('warn', `Cancelled ${task.outputRelative}`, task.id);
      } else {
        task.status = 'failed';
        task.error =
          error instanceof FfmpegError
            ? error.message.split(/\r?\n/).slice(-4).join(' | ')
            : (error as Error).message;
        this.ranTasks += 1;
        this.log('error', `FAILED ${task.sourceRelative}: ${task.error}`, task.id);
        this.record(task);
      }
    } finally {
      this.controllers.delete(task.id);
      this.activeSpeed.delete(task.id);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence                                                            */
  /* ---------------------------------------------------------------------- */

  private metadataIndexCache = new Map<string, Map<string, MetadataRecord>>();

  private async metadataIndex(outRoot: string): Promise<Map<string, MetadataRecord>> {
    const cached = this.metadataIndexCache.get(outRoot);
    if (cached) return cached;
    const index = await readMetadataIndex(outRoot);
    this.metadataIndexCache.set(outRoot, index);
    return index;
  }

  private record(task: TaskRecord): void {
    const entry: MetadataRecord = {
      source: task.sourceRelative,
      sourceAbsolute: task.sourcePath,
      output: task.outputRelative,
      degradation: task.degradation,
      severity: task.severity,
      level: task.level,
      parameters: task.params,
      filterChain: task.filterChain,
      status: task.status,
      processedAt: task.finishedAt ?? new Date().toISOString(),
      processingMs: task.processingMs,
      originalSha256: task.sourceSha256,
      outputSha256: task.outputSha256,
      sourceSizeBytes: task.sourceMeta.sizeBytes,
      outputSizeBytes: task.outputSizeBytes,
      durationSec: task.sourceMeta.durationSec,
      width: task.sourceMeta.width,
      height: task.sourceMeta.height,
      fps: task.sourceMeta.fps,
      codec: task.sourceMeta.codec,
      split: task.sourceMeta.split,
      error: task.error,
    };

    const pending = this.pendingRecords.get(task.root) ?? [];
    pending.push(entry);
    this.pendingRecords.set(task.root, pending);

    const all = this.allRecords.get(task.root) ?? [];
    all.push(entry);
    this.allRecords.set(task.root, all);

    this.sinceFlush += 1;
  }

  private async maybeFlush(): Promise<void> {
    if (this.sinceFlush >= FLUSH_EVERY_N || Date.now() - this.lastFlush >= FLUSH_EVERY_MS) {
      await this.flush();
    }
  }

  /** Serialised so two workers can never write metadata.json at the same time. */
  private flush(force = false): Promise<void> {
    if (!force && this.sinceFlush === 0) return Promise.resolve();

    const batches = new Map(this.pendingRecords);
    this.pendingRecords.clear();
    this.sinceFlush = 0;
    this.lastFlush = Date.now();

    this.flushChain = this.flushChain.then(async () => {
      for (const [root, records] of batches) {
        if (records.length === 0) continue;
        const outRoot = this.outputRootFor(root);
        const merged = await mergeMetadata(outRoot, records);
        // Keep the resume index in step with what is now on disk.
        this.metadataIndexCache.set(
          outRoot,
          new Map(merged.map((r) => [r.output, r])),
        );
      }
      await this.drainLogFile();
    });

    return this.flushChain;
  }

  /** Write the CSV, manifest and processing log for every dataset touched. */
  private async finalize(): Promise<string[]> {
    const counts = this.counts();
    const written: string[] = [];

    for (const scan of this.scans) {
      const outRoot = this.outputRootFor(scan.root);
      const exists = await fs.stat(outRoot).then(() => true).catch(() => false);
      if (!exists) continue;

      const index = await readMetadataIndex(outRoot);
      const records = [...index.values()];

      written.push(path.join(outRoot, 'metadata.json'));
      written.push(await writeMetadataCsv(outRoot, records));
      written.push(await writeManifest(outRoot, {
        inputFolder: scan.root,
        datasetName: scan.name,
        totalVideos: scan.videos.length,
        degradations: this.plan.degradations,
        severities: this.plan.severities,
        options: this.request.options,
        counts,
        records,
      }));
      written.push(
        await writeProcessingLog(outRoot, {
          jobId: this.id,
          startedAt: this.startedAt,
          finishedAt: this.finishedAt,
          status: this.status,
          counts,
          options: this.request.options,
          entries: this.logs,
        }),
      );
    }

    return written;
  }

  /** Append buffered log lines to logs/job-<id>.log. */
  private async drainLogFile(): Promise<void> {
    if (this.pendingLogLines.length === 0) return;
    const lines = this.pendingLogLines;
    this.pendingLogLines = [];
    try {
      const dir = path.join(process.cwd(), 'logs');
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(path.join(dir, `job-${this.id}.log`), `${lines.join('\n')}\n`, 'utf8');
    } catch {
      // The application log is a convenience; losing it must not affect a run.
    }
  }

  /** Force-write every report right now (used by the Export button). */
  async exportNow(): Promise<string[]> {
    await this.flush(true);
    return this.finalize();
  }
}

export type { TaskStatus };
