/**
 * Task planning.
 *
 * Expands (videos x degradations x levels) into concrete tasks. This is pure -
 * it touches no files - so the estimate the operator approves and the work the
 * engine actually performs are produced by the same code path and cannot drift
 * apart.
 */

import path from 'node:path';
import type {
  DatasetScan,
  DegradationId,
  JobRequest,
  OutputKind,
  Severity,
  TaskRecord,
  VideoMetadata,
} from '@/types';
import { COMBINED_ID, SEVERITIES } from '@/types';
import { COMBINED_DEFINITION, getDegradation, getLevel } from '@/lib/degradations';
import { buildCombined, getProcessor, type CombinedStep, type ProcessorOutput } from '@/processors';
import { resolveOutputRoot, sanitizeSegment, toPosix } from '@/utils/paths';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t${counter.toString(36)}`;
}

/**
 * Build the output filename.
 *
 * With a single level selected this produces exactly what the spec shows -
 * `video001_blur.mp4`. As soon as more than one level of the same degradation
 * is queued the level id is appended (`video001_blur_medium.mp4`), because two
 * severities cannot share one filename. "Always include severity in filename"
 * forces the long form for every run, which is the safer choice when a dataset
 * is built up over several sessions.
 */
function outputFileName(
  baseName: string,
  suffix: string,
  levelId: string,
  includeLevel: boolean,
): string {
  const parts = [sanitizeSegment(baseName), suffix];
  if (includeLevel) parts.push(sanitizeSegment(levelId));
  return `${parts.join('_')}.mp4`;
}

function makeTask(args: {
  scan: DatasetScan;
  video: VideoMetadata;
  kind: OutputKind;
  levelId: string;
  levelLabel: string;
  severity: Severity | null;
  outputRoot: string;
  folder: string;
  suffix: string;
  includeLevel: boolean;
  result: ProcessorOutput;
  baseCrf: number;
  preset: string;
  randomSet?: number | null;
}): TaskRecord {
  const {
    scan,
    video,
    kind,
    levelId,
    severity,
    outputRoot,
    folder,
    suffix,
    includeLevel,
    result,
    baseCrf,
    preset,
    randomSet = null,
  } = args;

  const fileName = outputFileName(video.baseName, suffix, levelId, includeLevel);
  // The source's folder layout is mirrored under each degradation folder, so
  // train/real/x.mp4 becomes blur/train/real/x_blur.mp4.
  const outputRelative = toPosix(path.join(folder, video.relativeDir, fileName));
  const outputPath = path.join(outputRoot, folder, video.relativeDir, fileName);

  const unusable = video.probeError !== null;

  return {
    id: nextId(),
    root: scan.root,
    datasetName: scan.name,
    sourcePath: video.path,
    sourceRelative: video.relativePath,
    outputPath,
    outputRoot,
    outputRelative,
    degradation: kind,
    level: levelId,
    severity,
    params: result.params as Record<string, number | string>,
    filterChain: result.filters.join(','),
    exec: {
      filters: result.filters,
      extraArgs: result.outputArgs,
      crf: result.crf ?? baseCrf,
      preset,
      forceCfr: result.forceCfr ?? false,
      outputFps: result.outputFps ?? null,
      audioCodec: video.audioCodec,
    },
    sourceMeta: {
      sizeBytes: video.sizeBytes,
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      fps: video.fps,
      codec: video.videoCodec,
      split: video.split,
    },
    status: unusable ? 'skipped' : result.skip ? 'skipped' : 'pending',
    progress: 0,
    attempts: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    processingMs: null,
    outputSizeBytes: null,
    sourceSha256: null,
    outputSha256: null,
    skipReason: unusable
      ? `source is unreadable: ${video.probeError}`
      : (result.skip ?? null),
    durationSec: video.durationSec,
    randomSet,
  };
}

export interface PlanResult {
  tasks: TaskRecord[];
  /** Folders that must exist under the output root, per dataset root. */
  foldersByRoot: Map<string, Set<string>>;
  /** The resolved output root for each dataset root. */
  outputRootByRoot: Map<string, string>;
  /** "1000 videos x 3 degradations x 3 severities = 9000 outputs" */
  formula: string;
  /** Distinct level ids that were queued, for the manifest. */
  severities: string[];
  degradations: OutputKind[];
}

/**
 * Which concrete level each degradation contributes to a combined output for a
 * given severity tier. Falls back to the first selected level when a
 * degradation has nothing at that tier (for example fps_reduction when only
 * "10 FPS" - which maps to no tier - was ticked).
 */
function stepsForTier(
  order: readonly DegradationId[],
  selectedLevels: Record<string, string[]>,
  tier: Severity,
): CombinedStep[] {
  const steps: CombinedStep[] = [];
  for (const id of order) {
    const ids = selectedLevels[id] ?? [];
    if (ids.length === 0) continue;
    const match = ids.find((levelId) => getLevel(id, levelId).tier === tier) ?? ids[0];
    steps.push({ id, level: getLevel(id, match) });
  }
  return steps;
}

/** Folder random-mode outputs are written under: random/set_1, random/set_2, ... */
export const RANDOM_FOLDER = 'random';

/** FNV-1a, so a string (seed + video path) becomes a 32-bit PRNG seed. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 - small, fast, deterministic. Returns floats in [0, 1). */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `count` (degradation, level) pairs for one video.
 *
 * The degradation is drawn uniformly first, then one of its selected levels,
 * so a degradation with four levels is not favoured over one with three. The
 * draw is seeded by the job seed and the video's path: the estimate, the run
 * and any later resume all see exactly the same assignment. Pairs are not
 * repeated for the same video until every pair has been used once.
 */
export function randomPicks(
  degradations: readonly DegradationId[],
  levels: Record<string, string[]>,
  count: number,
  seed: number,
  key: string,
): Array<{ id: DegradationId; levelId: string }> {
  const pool = degradations.filter((id) => (levels[id] ?? []).length > 0);
  if (pool.length === 0) return [];
  const total = pool.reduce((sum, id) => sum + levels[id].length, 0);

  const rand = seededRandom(hashString(`${seed}:${key}`));
  const picks: Array<{ id: DegradationId; levelId: string }> = [];
  let used = new Set<string>();

  for (let n = 0; n < count; n += 1) {
    if (used.size >= total) used = new Set();
    const open = pool.filter((id) => levels[id].some((l) => !used.has(`${id}/${l}`)));
    const id = open[Math.floor(rand() * open.length)];
    const free = levels[id].filter((l) => !used.has(`${id}/${l}`));
    const levelId = free[Math.floor(rand() * free.length)];
    used.add(`${id}/${levelId}`);
    picks.push({ id, levelId });
  }
  return picks;
}

export function planTasks(request: JobRequest, scans: readonly DatasetScan[]): PlanResult {
  const { options } = request;
  const tasks: TaskRecord[] = [];
  const foldersByRoot = new Map<string, Set<string>>();
  const outputRootByRoot = new Map<string, string>();
  const levelIdsSeen = new Set<string>();
  const kindsUsed = new Set<OutputKind>();

  // Keep the user's configured chain order, restricted to what is selected.
  const combinedOrder = options.combinedOrder.filter((id) => request.degradations.includes(id));
  const orderedDegradations =
    combinedOrder.length === request.degradations.length
      ? combinedOrder
      : [...combinedOrder, ...request.degradations.filter((id) => !combinedOrder.includes(id))];

  // Which severity tiers are represented across the whole selection.
  const tiers: Severity[] = SEVERITIES.filter((tier) =>
    orderedDegradations.some((id) =>
      (request.levels[id] ?? []).some((levelId) => getLevel(id, levelId).tier === tier),
    ),
  );

  const randomMode = options.randomMode === true;
  const randomSets = Math.max(1, options.randomSets ?? 2);
  const randomSeed = options.randomSeed ?? 1;

  const wantCombined =
    !randomMode && options.includeCombined && orderedDegradations.length >= 2 && tiers.length > 0;

  for (const scan of scans) {
    const folders = new Set<string>();
    // Blank options.outputRoot keeps the default <dataset>/degraded_output.
    const outRoot = resolveOutputRoot(scan.root, options.outputRoot);
    outputRootByRoot.set(scan.root, outRoot);

    for (const video of scan.videos) {
      const ctx = {
        video: {
          width: video.width,
          height: video.height,
          fps: video.fps,
          durationSec: video.durationSec,
          audioCodec: video.audioCodec,
        },
        baseCrf: options.baseCrf,
      };

      if (randomMode) {
        const picks = randomPicks(
          orderedDegradations,
          request.levels,
          randomSets,
          randomSeed,
          video.relativePath,
        );
        picks.forEach(({ id, levelId }, index) => {
          const set = index + 1;
          const definition = getDegradation(id);
          const level = getLevel(id, levelId);
          const folder = `${RANDOM_FOLDER}/set_${set}`;
          tasks.push(
            makeTask({
              scan,
              video,
              kind: id,
              levelId,
              levelLabel: level.label,
              severity: level.tier,
              outputRoot: outRoot,
              folder,
              suffix: definition.suffix,
              // Sets mix severities, so the level is always in the name.
              includeLevel: true,
              result: getProcessor(id)(level, ctx),
              baseCrf: options.baseCrf,
              preset: options.encoderPreset,
              randomSet: set,
            }),
          );
          folders.add(folder);
          levelIdsSeen.add(levelId);
          kindsUsed.add(id);
        });
        continue;
      }

      for (const id of orderedDegradations) {
        const levelIds = request.levels[id] ?? [];
        if (levelIds.length === 0) continue;

        const definition = getDegradation(id);
        const includeLevel = options.alwaysIncludeSeverityInName || levelIds.length > 1;

        for (const levelId of levelIds) {
          const level = getLevel(id, levelId);
          const result = getProcessor(id)(level, ctx);

          tasks.push(
            makeTask({
              scan,
              video,
              kind: id,
              levelId,
              levelLabel: level.label,
              severity: level.tier,
              outputRoot: outRoot,
              folder: definition.folder,
              suffix: definition.suffix,
              includeLevel,
              result,
              baseCrf: options.baseCrf,
              preset: options.encoderPreset,
            }),
          );

          folders.add(definition.folder);
          levelIdsSeen.add(levelId);
          kindsUsed.add(id);
        }
      }

      if (wantCombined) {
        const includeLevel = options.alwaysIncludeSeverityInName || tiers.length > 1;
        for (const tier of tiers) {
          const steps = stepsForTier(orderedDegradations, request.levels, tier);
          if (steps.length < 2) continue;

          const result = buildCombined(steps, ctx);
          tasks.push(
            makeTask({
              scan,
              video,
              kind: COMBINED_ID,
              levelId: tier,
              levelLabel: tier,
              severity: tier,
              outputRoot: outRoot,
              folder: COMBINED_DEFINITION.folder,
              suffix: COMBINED_DEFINITION.suffix,
              includeLevel,
              result,
              baseCrf: options.baseCrf,
              preset: options.encoderPreset,
            }),
          );
          folders.add(COMBINED_DEFINITION.folder);
          kindsUsed.add(COMBINED_ID);
        }
      }
    }

    foldersByRoot.set(scan.root, folders);
  }

  const totalVideos = scans.reduce((sum, s) => sum + s.videos.length, 0);
  const degradationCount = orderedDegradations.length;

  // How many outputs each video produces, counted rather than assumed so the
  // arithmetic shown to the operator always multiplies out to the real total.
  const levelCounts = orderedDegradations.map((id) => (request.levels[id] ?? []).length);
  const perDegradation = levelCounts.reduce((sum, n) => sum + n, 0);
  const combinedPerVideo = wantCombined ? tiers.length : 0;

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  // When every degradation runs the same number of levels the classic
  // "videos x degradations x severities" reading is exact, so use it.
  const uniform =
    levelCounts.length > 0 && levelCounts.every((n) => n === levelCounts[0]) && levelCounts[0] > 0;

  let formula: string;
  if (randomMode) {
    formula =
      `${totalVideos} ${plural(totalVideos, 'video', 'videos')} x ` +
      `${randomSets} random ${plural(randomSets, 'set', 'sets')} ` +
      `(from ${degradationCount} ${plural(degradationCount, 'degradation', 'degradations')}) = ` +
      `${tasks.length} outputs`;
  } else if (totalVideos === 0 || degradationCount === 0) {
    formula = `${totalVideos} videos selected = ${tasks.length} outputs`;
  } else if (uniform && !wantCombined) {
    const k = levelCounts[0];
    formula =
      `${totalVideos} ${plural(totalVideos, 'video', 'videos')} x ` +
      `${degradationCount} ${plural(degradationCount, 'degradation', 'degradations')} x ` +
      `${k} ${plural(k, 'severity', 'severities')} = ${tasks.length} outputs`;
  } else if (uniform && wantCombined) {
    const k = levelCounts[0];
    formula =
      `${totalVideos} ${plural(totalVideos, 'video', 'videos')} x ` +
      `(${degradationCount} x ${k} + ${combinedPerVideo} combined) = ${tasks.length} outputs`;
  } else {
    // Mixed level counts: state the per-video total explicitly instead of
    // implying a multiplication that does not hold.
    const perVideo = perDegradation + combinedPerVideo;
    formula =
      `${totalVideos} ${plural(totalVideos, 'video', 'videos')} x ` +
      `(${perDegradation} degradation ${plural(perDegradation, 'output', 'outputs')}` +
      (wantCombined ? ` + ${combinedPerVideo} combined` : '') +
      `) = ${totalVideos} x ${perVideo} = ${tasks.length} outputs`;
  }

  return {
    tasks,
    foldersByRoot,
    outputRootByRoot,
    formula,
    severities: [...levelIdsSeen],
    degradations: [...kindsUsed],
  };
}
