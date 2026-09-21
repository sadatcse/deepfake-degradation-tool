/**
 * The persistence layer. There is no database anywhere in this project: every
 * durable fact lives in a JSON or CSV file inside `degraded_output/`.
 *
 *   metadata.json        one record per output, with parameters + checksums
 *   metadata.csv         the same records, flattened for spreadsheets/pandas
 *   manifest.json        dataset-level summary and the source -> outputs map
 *   processing_log.json  the run log, including failures
 *
 * Writes are atomic (temp file + rename) so a crash or a pulled power cable
 * can never leave a half-written metadata file behind - which matters, because
 * these files are what resume reads on the next start.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  JobCounts,
  JobOptions,
  LogEntry,
  Manifest,
  MetadataRecord,
  OutputKind,
} from '@/types';
import { toCsv } from '@/utils/csv';
import { OUTPUT_DIR_NAME, assertInside, toPosix } from '@/utils/paths';

export const METADATA_FILE = 'metadata.json';
export const METADATA_CSV = 'metadata.csv';
export const MANIFEST_FILE = 'manifest.json';
export const PROCESSING_LOG_FILE = 'processing_log.json';

export const TOOL_NAME = 'DeepFake Bulk Video Degradation Tool';
export const TOOL_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Atomic IO                                                                  */
/* -------------------------------------------------------------------------- */

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // Unique temp name so two flushes can never collide on the same file.
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (error) {
    // rename across an existing file fails on some Windows configurations.
    await fs.rm(filePath, { force: true });
    await fs.rename(tmp, filePath).catch(async (retryError) => {
      await fs.rm(tmp, { force: true });
      throw retryError ?? error;
    });
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    // Missing or corrupt: treat as empty. A corrupt metadata file must not stop
    // a run - the outputs on disk are still the source of truth for resume.
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* metadata.json                                                              */
/* -------------------------------------------------------------------------- */

export function metadataPath(outputRoot: string): string {
  return path.join(outputRoot, METADATA_FILE);
}

export async function readMetadata(outputRoot: string): Promise<MetadataRecord[]> {
  const records = await readJson<MetadataRecord[]>(metadataPath(outputRoot), []);
  return Array.isArray(records) ? records : [];
}

/**
 * Index existing records by their output path, so resume can ask
 * "has this exact output already been produced, and with what settings?".
 */
export async function readMetadataIndex(
  outputRoot: string,
): Promise<Map<string, MetadataRecord>> {
  const records = await readMetadata(outputRoot);
  const index = new Map<string, MetadataRecord>();
  for (const record of records) {
    if (record && typeof record.output === 'string') index.set(record.output, record);
  }
  return index;
}

/**
 * Merge new records into whatever is already on disk, keyed by output path so a
 * re-run updates a record rather than duplicating it.
 */
export async function mergeMetadata(
  outputRoot: string,
  incoming: readonly MetadataRecord[],
): Promise<MetadataRecord[]> {
  const index = await readMetadataIndex(outputRoot);

  for (const record of incoming) {
    const existing = index.get(record.output);

    // metadata.json describes files that exist on disk. A failed or skipped
    // attempt must never overwrite the record of an output that was actually
    // produced - doing so loses the real parameters and checksums of the file
    // sitting there, and blinds the "same name, different settings" check on a
    // later run.
    if (existing?.status === 'completed' && record.status !== 'completed') continue;

    index.set(record.output, record);
  }

  const merged = [...index.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.output.localeCompare(b.output),
  );
  await writeAtomic(metadataPath(outputRoot), `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

/* -------------------------------------------------------------------------- */
/* metadata.csv                                                               */
/* -------------------------------------------------------------------------- */

const CSV_HEADERS = [
  'source_file',
  'output_file',
  'degradation',
  'severity',
  'level',
  'duration',
  'width',
  'height',
  'fps',
  'codec',
  'status',
  'processing_time',
  'source_size_bytes',
  'output_size_bytes',
  'original_sha256',
  'output_sha256',
  'split',
  'parameters',
  'filter_chain',
  'processed_at',
  'error',
] as const;

export async function writeMetadataCsv(
  outputRoot: string,
  records: readonly MetadataRecord[],
): Promise<string> {
  const rows = records.map((r) => [
    r.source,
    r.output,
    r.degradation,
    r.severity ?? '',
    r.level,
    r.durationSec ?? '',
    r.width ?? '',
    r.height ?? '',
    r.fps ?? '',
    r.codec ?? '',
    r.status,
    // Seconds, with millisecond resolution - convenient for spreadsheets.
    r.processingMs === null ? '' : (r.processingMs / 1000).toFixed(3),
    r.sourceSizeBytes,
    r.outputSizeBytes ?? '',
    r.originalSha256 ?? '',
    r.outputSha256 ?? '',
    r.split ?? '',
    JSON.stringify(r.parameters),
    r.filterChain,
    r.processedAt,
    r.error ?? '',
  ]);

  const target = path.join(outputRoot, METADATA_CSV);
  await writeAtomic(target, toCsv(CSV_HEADERS, rows));
  return target;
}

/* -------------------------------------------------------------------------- */
/* manifest.json                                                              */
/* -------------------------------------------------------------------------- */

export interface ManifestInput {
  inputFolder: string;
  datasetName: string;
  totalVideos: number;
  degradations: OutputKind[];
  severities: string[];
  options: JobOptions;
  counts: JobCounts;
  records: readonly MetadataRecord[];
}

export async function writeManifest(outputRoot: string, input: ManifestInput): Promise<string> {
  const target = path.join(outputRoot, MANIFEST_FILE);
  const previous = await readJson<Partial<Manifest>>(target, {});

  // Group outputs under their source so lineage is readable at a glance.
  const bySource = new Map<string, Manifest['files'][number]>();
  for (const record of input.records) {
    if (record.status !== 'completed') continue;
    const entry = bySource.get(record.source) ?? { source: record.source, outputs: [] };
    entry.outputs.push({
      output: record.output,
      degradation: record.degradation,
      level: record.level,
    });
    bySource.set(record.source, entry);
  }

  const manifest: Manifest = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    inputFolder: input.inputFolder,
    datasetName: input.datasetName,
    createdAt: previous.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalVideos: input.totalVideos,
    totalOutputs: [...bySource.values()].reduce((sum, f) => sum + f.outputs.length, 0),
    degradations: input.degradations,
    severities: input.severities,
    options: input.options,
    counts: input.counts,
    files: [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };

  await writeAtomic(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

/* -------------------------------------------------------------------------- */
/* processing_log.json                                                        */
/* -------------------------------------------------------------------------- */

export interface ProcessingLogInput {
  jobId: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string;
  counts: JobCounts;
  options: JobOptions;
  entries: readonly LogEntry[];
}

/** Keep the on-disk log bounded; a 9000-task run can emit a lot of lines. */
const MAX_LOG_ENTRIES = 20_000;

export async function writeProcessingLog(
  outputRoot: string,
  input: ProcessingLogInput,
): Promise<string> {
  const target = path.join(outputRoot, PROCESSING_LOG_FILE);
  const previous = await readJson<{ runs?: unknown[] }>(target, {});
  const runs = Array.isArray(previous.runs) ? previous.runs : [];

  const entries =
    input.entries.length > MAX_LOG_ENTRIES
      ? input.entries.slice(input.entries.length - MAX_LOG_ENTRIES)
      : input.entries;

  // Replace the entry for this job id if it is already present (a resumed or
  // re-exported run), otherwise append.
  const withoutThisRun = runs.filter(
    (r) => !(typeof r === 'object' && r !== null && (r as { jobId?: string }).jobId === input.jobId),
  );

  const payload = {
    tool: TOOL_NAME,
    version: TOOL_VERSION,
    updatedAt: new Date().toISOString(),
    runs: [
      ...withoutThisRun,
      {
        jobId: input.jobId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        status: input.status,
        counts: input.counts,
        options: input.options,
        truncated: entries.length < input.entries.length,
        entries,
      },
    ],
  };

  await writeAtomic(target, `${JSON.stringify(payload, null, 2)}\n`);
  return target;
}

/* -------------------------------------------------------------------------- */
/* Folder preparation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Create `degraded_output/<folder>/...` for a task's output, refusing to create
 * anything outside the dataset's own output root.
 */
export async function ensureOutputDir(outputRoot: string, targetFile: string): Promise<void> {
  const dir = path.dirname(targetFile);
  assertInside(outputRoot, dir, 'output directory');
  await fs.mkdir(dir, { recursive: true });
}

/** Pre-create the per-degradation folders so the layout is visible immediately. */
export async function prepareOutputFolders(
  outputRoot: string,
  folders: readonly string[],
): Promise<void> {
  await fs.mkdir(outputRoot, { recursive: true });
  await Promise.all(
    folders.map((folder) => fs.mkdir(path.join(outputRoot, folder), { recursive: true })),
  );
}

/** A README dropped next to the outputs so the folder explains itself later. */
export async function writeOutputReadme(outputRoot: string, datasetRoot: string): Promise<void> {
  const target = path.join(outputRoot, 'README.txt');
  const exists = await fs.stat(target).then(() => true).catch(() => false);
  if (exists) return;

  const lines = [
    `${TOOL_NAME} v${TOOL_VERSION}`,
    '',
    `Generated from: ${datasetRoot}`,
    `Generated at:   ${new Date().toISOString()}`,
    '',
    'The original videos in the source folder above were never modified,',
    'renamed, moved or deleted. Everything in here is generated output and',
    'can be deleted safely to start again.',
    '',
    'Files',
    '-----',
    `${METADATA_FILE}        one record per output: parameters, checksums, lineage`,
    `${METADATA_CSV}         the same records as CSV`,
    `${MANIFEST_FILE}        dataset summary and the source -> outputs map`,
    `${PROCESSING_LOG_FILE}  per-run processing log, including failures`,
    '',
    'Each subfolder holds one degradation type and mirrors the folder layout',
    `of the source dataset. Re-running the tool reads ${METADATA_FILE} and skips`,
    'outputs that already exist.',
    '',
  ];
  await writeAtomic(target, lines.join('\n'));
}

export function outputRootFor(datasetRoot: string): string {
  return path.join(datasetRoot, OUTPUT_DIR_NAME);
}

export { toPosix };
