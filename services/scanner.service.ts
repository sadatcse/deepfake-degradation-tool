/**
 * Dataset discovery.
 *
 * Walks a folder, finds supported videos and probes each one. The walk never
 * descends into `degraded_output`, so re-scanning a folder that has already
 * been processed will not pick up the tool's own output as new input.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CountBucket, DatasetScan, ScanSummary, VideoMetadata } from '@/types';
import { SUPPORTED_EXTENSIONS } from '@/types';
import { mapLimit } from '@/utils/concurrency';
import {
  OUTPUT_DIR_NAME,
  assertAllowed,
  datasetName,
  isIgnoredDir,
  normalize,
  toPosix,
} from '@/utils/paths';
import { probeVideo } from './ffprobe.service';

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/* -------------------------------------------------------------------------- */
/* Progress reporting                                                         */
/* -------------------------------------------------------------------------- */

export interface ScanProgress {
  phase: 'walking' | 'probing' | 'done' | 'error';
  found: number;
  probed: number;
  current: string;
  error?: string;
  updatedAt: number;
}

const progressStore = new Map<string, ScanProgress>();

export function getScanProgress(token: string): ScanProgress | null {
  return progressStore.get(token) ?? null;
}

function setProgress(token: string | undefined, patch: Partial<ScanProgress>): void {
  if (!token) return;
  const current =
    progressStore.get(token) ??
    ({ phase: 'walking', found: 0, probed: 0, current: '', updatedAt: Date.now() } as ScanProgress);
  progressStore.set(token, { ...current, ...patch, updatedAt: Date.now() });
}

/** Drop scan-progress entries nobody has polled for a while. */
function pruneProgress(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [token, value] of progressStore) {
    if (value.updatedAt < cutoff) progressStore.delete(token);
  }
}

/* -------------------------------------------------------------------------- */
/* Walking                                                                    */
/* -------------------------------------------------------------------------- */

interface FoundFile {
  absolute: string;
  relative: string;
}

async function walk(
  root: string,
  dir: string,
  out: FoundFile[],
  token: string | undefined,
  depth = 0,
): Promise<void> {
  if (depth > 32) return; // guard against pathological nesting / symlink loops

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory: skip it rather than failing the whole scan
  }

  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      await walk(root, absolute, out, token, depth + 1);
      continue;
    }

    if (!entry.isFile()) continue; // ignore symlinks, sockets, devices
    if (!SUPPORTED.has(path.extname(entry.name).toLowerCase())) continue;

    out.push({ absolute, relative: toPosix(path.relative(root, absolute)) });
    if (out.length % 25 === 0) {
      setProgress(token, { phase: 'walking', found: out.length, current: entry.name });
    }
  }
}

/** Detect a train/validation/test split from the first path segment. */
function detectSplit(relativePath: string): VideoMetadata['split'] {
  const top = relativePath.split('/')[0]?.toLowerCase();
  if (top === 'train' || top === 'training') return 'train';
  if (top === 'validation' || top === 'val' || top === 'valid') return 'validation';
  if (top === 'test' || top === 'testing') return 'test';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

function tally(values: Array<string | null>, limit = 12): CountBucket[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit - 1);
  const rest = sorted.slice(limit - 1).reduce((sum, item) => sum + item.count, 0);
  return [...head, { label: `other (${sorted.length - limit + 1})`, count: rest }];
}

function fpsBucket(fps: number | null): string {
  if (fps === null) return 'unknown';
  const rounded = Math.round(fps);
  if (rounded <= 0) return 'unknown';
  if (rounded <= 12) return '<= 12 fps';
  if (rounded <= 16) return '15 fps';
  if (rounded <= 26) return '24-25 fps';
  if (rounded <= 32) return '30 fps';
  if (rounded <= 52) return '50 fps';
  if (rounded <= 65) return '60 fps';
  return '> 65 fps';
}

function summarize(root: string, videos: VideoMetadata[]): ScanSummary {
  return {
    root,
    totalVideos: videos.length,
    totalSizeBytes: videos.reduce((sum, v) => sum + v.sizeBytes, 0),
    totalDurationSec: videos.reduce((sum, v) => sum + (v.durationSec ?? 0), 0),
    unreadable: videos.filter((v) => v.probeError !== null).length,
    resolutions: tally(
      videos.map((v) => (v.width && v.height ? `${v.width}x${v.height}` : null)),
    ),
    fpsBuckets: tally(videos.map((v) => fpsBucket(v.fps))),
    codecs: tally(videos.map((v) => v.videoCodec)),
    splits: tally(videos.map((v) => v.split ?? 'none')),
    extensions: tally(videos.map((v) => v.extension)),
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ScanOptions {
  /** Token used to publish progress for /api/scan/progress. */
  token?: string;
  /** Parallel ffprobe processes. */
  concurrency?: number;
  /** Skip ffprobe entirely - much faster, but no duration/resolution data. */
  probe?: boolean;
}

export async function scanDataset(rootInput: string, options: ScanOptions = {}): Promise<DatasetScan> {
  pruneProgress();

  const root = assertAllowed(normalize(rootInput));
  const token = options.token;

  const stat = await fs.stat(root).catch(() => null);
  if (!stat) throw new Error(`Folder not found: ${root}`);
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${root}`);

  setProgress(token, { phase: 'walking', found: 0, probed: 0, current: root });

  const files: FoundFile[] = [];
  await walk(root, root, files, token);
  files.sort((a, b) => a.relative.localeCompare(b.relative, 'en', { numeric: true }));

  setProgress(token, { phase: 'probing', found: files.length, probed: 0 });

  let probed = 0;
  const shouldProbe = options.probe !== false;
  const concurrency = Math.max(1, options.concurrency ?? 8);

  const videos = await mapLimit(files, concurrency, async (file): Promise<VideoMetadata> => {
    const extension = path.extname(file.absolute).toLowerCase();
    const fileName = path.basename(file.absolute);
    const relativeDir = toPosix(path.dirname(file.relative)) === '.' ? '' : toPosix(path.dirname(file.relative));

    let sizeBytes = 0;
    let modifiedAt = new Date(0).toISOString();
    try {
      const s = await fs.stat(file.absolute);
      sizeBytes = s.size;
      modifiedAt = s.mtime.toISOString();
    } catch {
      // Keep going; the probe below will report the real problem.
    }

    const probe = shouldProbe
      ? await probeVideo(file.absolute)
      : {
          durationSec: null,
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: null,
          bitrateBps: null,
          pixelFormat: null,
          rotationDeg: 0,
          error: null,
        };

    probed += 1;
    if (probed % 5 === 0 || probed === files.length) {
      setProgress(token, { phase: 'probing', probed, current: file.relative });
    }

    return {
      path: file.absolute,
      relativePath: file.relative,
      relativeDir,
      fileName,
      baseName: path.basename(fileName, extension),
      extension,
      sizeBytes,
      modifiedAt,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      bitrateBps: probe.bitrateBps,
      pixelFormat: probe.pixelFormat,
      split: detectSplit(file.relative),
      probeError: probe.error,
    };
  });

  const hasExistingOutput = await fs
    .stat(path.join(root, OUTPUT_DIR_NAME))
    .then((s) => s.isDirectory())
    .catch(() => false);

  setProgress(token, { phase: 'done', found: files.length, probed: files.length, current: '' });

  return {
    root,
    name: datasetName(root),
    scannedAt: new Date().toISOString(),
    videos,
    summary: summarize(root, videos),
    hasExistingOutput,
  };
}

export function markScanFailed(token: string | undefined, error: string): void {
  setProgress(token, { phase: 'error', error });
}
