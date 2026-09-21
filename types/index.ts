/**
 * Shared domain types for the DeepFake Bulk Video Degradation Tool.
 *
 * These types are used by both the server (services/processors) and the client
 * (components). There is deliberately no database layer: every piece of durable
 * state is a JSON/CSV file on disk.
 */

/* -------------------------------------------------------------------------- */
/* Degradations                                                               */
/* -------------------------------------------------------------------------- */

export const DEGRADATION_IDS = [
  'blur',
  'noise',
  'compression',
  'low_resolution',
  'fps_reduction',
  'frame_drop',
  'motion_blur',
  'brightness',
  'contrast',
  'saturation',
] as const;

export type DegradationId = (typeof DEGRADATION_IDS)[number];

/** `combined` is not selectable on its own - it chains the selected degradations. */
export const COMBINED_ID = 'combined';
export type OutputKind = DegradationId | typeof COMBINED_ID;

/** The three canonical severity tiers exposed in the main UI. */
export const SEVERITIES = ['mild', 'medium', 'severe'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * A concrete, runnable variant of a degradation.
 *
 * Most degradations have exactly three levels (mild/medium/severe). A few have
 * a richer menu the spec calls out explicitly - resolution (720p/480p/360p/240p),
 * fps (30/24/15/10/5) and frame drop (5/10/20/30%). Those extra levels are
 * selectable in the "Advanced levels" panel; the three severity tiers map onto
 * a sensible default from each menu.
 */
export interface DegradationLevel {
  /** Stable id used in filenames + metadata, e.g. "medium", "480p", "15fps". */
  id: string;
  /** Human label shown in the UI. */
  label: string;
  /** Which severity tier this level is the default for, if any. */
  tier: Severity | null;
  /** Short description of what actually happens, e.g. "CRF 34". */
  summary: string;
  /** Raw parameters handed to the processor. */
  params: Record<string, number | string>;
}

export interface DegradationDefinition {
  id: OutputKind;
  label: string;
  description: string;
  /** Folder created under degraded_output/. */
  folder: string;
  /** Filename suffix, e.g. video001_blur.mp4. */
  suffix: string;
  levels: DegradationLevel[];
}

/* -------------------------------------------------------------------------- */
/* Video discovery + metadata                                                 */
/* -------------------------------------------------------------------------- */

export const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'] as const;

export interface VideoMetadata {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the dataset root, POSIX separators. Preserves folders. */
  relativePath: string;
  /** Directory part of relativePath (empty when the file sits at the root). */
  relativeDir: string;
  /** File name with extension. */
  fileName: string;
  /** File name without extension. */
  baseName: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;

  /** Populated by ffprobe. Null when the file could not be probed. */
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateBps: number | null;
  pixelFormat: string | null;
  /** Dataset split detected from the top-level folder, when present. */
  split: 'train' | 'validation' | 'test' | null;
  /** Non-fatal probe problem; the file is still listed but marked unusable. */
  probeError: string | null;
}

export interface CountBucket {
  label: string;
  count: number;
}

export interface ScanSummary {
  root: string;
  totalVideos: number;
  totalSizeBytes: number;
  totalDurationSec: number;
  unreadable: number;
  resolutions: CountBucket[];
  fpsBuckets: CountBucket[];
  codecs: CountBucket[];
  splits: CountBucket[];
  extensions: CountBucket[];
}

export interface DatasetScan {
  root: string;
  name: string;
  scannedAt: string;
  videos: VideoMetadata[];
  summary: ScanSummary;
  /** True when degraded_output/ already exists in this folder. */
  hasExistingOutput: boolean;
}

/* -------------------------------------------------------------------------- */
/* Job configuration                                                          */
/* -------------------------------------------------------------------------- */

export interface JobOptions {
  /** Parallel ffmpeg processes. */
  workers: number;
  /** Skip a task when its output file already exists. */
  skipExisting: boolean;
  /** Re-encode even when the output exists (overrides skipExisting). */
  forceReprocess: boolean;
  /** Compute SHA-256 for sources and outputs. */
  computeChecksums: boolean;
  /** Always append the severity/level id to the output filename. */
  alwaysIncludeSeverityInName: boolean;
  /** CRF used for degradations that are not themselves "compression". */
  baseCrf: number;
  /** x264 preset for every encode. */
  encoderPreset: string;
  /** Order in which degradations are chained for the combined output. */
  combinedOrder: DegradationId[];
  /** Emit a combined/ output chaining every selected degradation. */
  includeCombined: boolean;
  /**
   * Where output is written. Null (the default) means
   * `<dataset>/degraded_output`. A custom root nests each dataset one level
   * under it by name: `<outputRoot>/<datasetName>/blur/...`.
   */
  outputRoot: string | null;
}

export interface JobRequest {
  /** One or more dataset roots; each gets its own degraded_output/. */
  roots: string[];
  degradations: DegradationId[];
  /** Selected level ids per degradation. */
  levels: Record<string, string[]>;
  options: JobOptions;
}

/* -------------------------------------------------------------------------- */
/* Tasks + job state                                                          */
/* -------------------------------------------------------------------------- */

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface TaskRecord {
  id: string;
  root: string;
  datasetName: string;
  sourcePath: string;
  sourceRelative: string;
  outputPath: string;
  /** The resolved output root this task writes beneath. */
  outputRoot: string;
  /** Output path relative to the output root. */
  outputRelative: string;
  degradation: OutputKind;
  /** Level id, e.g. "medium" or "480p". */
  level: string;
  /** Severity tier this level belongs to, when it maps onto one. */
  severity: Severity | null;
  params: Record<string, unknown>;
  /** Human-readable -vf chain, shown in the UI before anything is encoded. */
  filterChain: string;
  /** Everything the encoder needs; resolved once at plan time. */
  exec: {
    filters: string[];
    extraArgs: string[];
    crf: number;
    preset: string;
    forceCfr: boolean;
    outputFps: number | null;
    audioCodec: string | null;
  };
  /** Compact copy of the source's probe data, for the metadata record. */
  sourceMeta: {
    sizeBytes: number;
    durationSec: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    codec: string | null;
    split: string | null;
  };
  status: TaskStatus;
  progress: number;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  processingMs: number | null;
  outputSizeBytes: number | null;
  sourceSha256: string | null;
  outputSha256: string | null;
  /** Reason a task was skipped, shown verbatim in the UI. */
  skipReason: string | null;
  /** Source duration, cached so progress can be computed without re-probing. */
  durationSec: number | null;
}

export type JobStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface JobCounts {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface ActiveTaskView {
  taskId: string;
  sourceRelative: string;
  degradation: OutputKind;
  level: string;
  severity: Severity | null;
  progress: number;
  speed: string | null;
}

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  request: JobRequest;
  counts: JobCounts;
  /** Tasks currently occupying a worker slot. */
  active: ActiveTaskView[];
  /** Bytes written by completed tasks so far. */
  outputBytes: number;
  /** Milliseconds of wall clock spent processing. */
  elapsedMs: number;
  /** Estimate in milliseconds, null until enough samples exist. */
  etaMs: number | null;
  datasets: Array<{ root: string; name: string; total: number; done: number }>;
}

export interface LogEntry {
  ts: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  taskId?: string;
}

/* -------------------------------------------------------------------------- */
/* Estimation + disk                                                          */
/* -------------------------------------------------------------------------- */

export interface EstimateBreakdown {
  degradation: OutputKind;
  level: string;
  label: string;
  outputs: number;
  estimatedBytes: number;
}

export interface Estimate {
  totalVideos: number;
  totalOutputs: number;
  inputBytes: number;
  estimatedOutputBytes: number;
  breakdown: EstimateBreakdown[];
  /** "1000 x 3 x 3 = 9000" style explanation of the multiplication. */
  formula: string;
}

export interface DiskInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  ok: boolean;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export interface BinaryInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  /** Parsed major/minor, used to pick modern vs legacy ffmpeg flags. */
  major: number | null;
  minor: number | null;
  error: string | null;
}

export interface SystemInfo {
  ffmpeg: BinaryInfo;
  ffprobe: BinaryInfo;
  platform: string;
  cpuCount: number;
  totalMemoryBytes: number;
  allowedRoots: string[] | null;
  instructions: string[];
}

/* -------------------------------------------------------------------------- */
/* Filesystem browsing                                                        */
/* -------------------------------------------------------------------------- */

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
  /** Windows drive roots, or / on POSIX, shown at the top level. */
  roots: DirEntry[];
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

export interface PreviewClip {
  degradation: OutputKind | 'original';
  level: string;
  label: string;
  summary: string;
  filterChain: string;
  /** URL served by /api/media. */
  url: string;
  sizeBytes: number;
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* On-disk records (metadata.json / manifest.json / processing_log.json)      */
/* -------------------------------------------------------------------------- */

export interface MetadataRecord {
  source: string;
  sourceAbsolute: string;
  output: string;
  degradation: OutputKind;
  severity: Severity | null;
  level: string;
  parameters: Record<string, unknown>;
  filterChain: string;
  status: TaskStatus;
  processedAt: string;
  processingMs: number | null;
  originalSha256: string | null;
  outputSha256: string | null;
  sourceSizeBytes: number;
  outputSizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
  split: string | null;
  error: string | null;
}

export interface Manifest {
  tool: string;
  version: string;
  inputFolder: string;
  datasetName: string;
  createdAt: string;
  updatedAt: string;
  totalVideos: number;
  totalOutputs: number;
  degradations: OutputKind[];
  severities: string[];
  options: JobOptions;
  counts: JobCounts;
  files: Array<{
    source: string;
    outputs: Array<{ output: string; degradation: OutputKind; level: string }>;
  }>;
}
