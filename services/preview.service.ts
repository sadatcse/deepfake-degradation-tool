/**
 * Sample previews.
 *
 * Encodes a few seconds of one chosen video through each selected degradation
 * so the operator can confirm the settings look right before committing to
 * thousands of files. Previews live in `degraded_output/.previews/`, which the
 * scanner ignores, so they can never be mistaken for dataset content.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatasetScan, JobOptions, OutputKind, PreviewClip, Severity } from '@/types';
import { COMBINED_ID } from '@/types';
import { COMBINED_DEFINITION, getDegradation, getLevel } from '@/lib/degradations';
import { buildCombined, getProcessor, type CombinedStep, type ProcessorOutput } from '@/processors';
import { PREVIEW_DIR_NAME, assertInside, resolveOutputRoot, sanitizeSegment } from '@/utils/paths';
import { buildEncodeArgs, requireFfmpeg, runFfmpeg } from './ffmpeg.service';

export interface PreviewRequest {
  root: string;
  /** Relative path of the sample video inside the dataset. */
  video: string;
  selections: Array<{ degradation: OutputKind; level: string }>;
  /** Combined steps, when a combined preview is requested. */
  combined?: { tier: Severity; steps: Array<{ degradation: string; level: string }> };
  seconds: number;
  options: Pick<JobOptions, 'baseCrf' | 'encoderPreset'> & {
    /** Matches the job's setting so previews land beside the real output. */
    outputRoot?: string | null;
  };
}

const MAX_SECONDS = 15;
const MIN_SECONDS = 1;

/** Previews live inside the resolved output root, which the scanner ignores. */
export function previewRoot(datasetRoot: string, customRoot?: string | null): string {
  return path.join(resolveOutputRoot(datasetRoot, customRoot), PREVIEW_DIR_NAME);
}

function mediaUrl(absolutePath: string): string {
  return `/api/media?path=${encodeURIComponent(absolutePath)}`;
}

/**
 * Start a little way into the clip. The opening second of a video is often a
 * fade or a slate, which makes a poor comparison frame.
 */
function clipStart(durationSec: number | null, seconds: number): number {
  if (!durationSec || durationSec <= seconds) return 0;
  return Math.min(Math.max(1, durationSec * 0.1), Math.max(0, durationSec - seconds));
}

export async function generatePreviews(
  scan: DatasetScan,
  request: PreviewRequest,
): Promise<PreviewClip[]> {
  const bin = await requireFfmpeg();

  const video = scan.videos.find((v) => v.relativePath === request.video);
  if (!video) throw new Error(`Video not found in the scanned dataset: ${request.video}`);
  if (video.probeError) throw new Error(`This video is unreadable: ${video.probeError}`);

  const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(request.seconds || 4)));
  const start = clipStart(video.durationSec, seconds);

  const root = previewRoot(scan.root, request.options.outputRoot);
  const dir = path.join(root, sanitizeSegment(video.baseName));
  await fs.mkdir(dir, { recursive: true });
  assertInside(root, dir, 'preview directory');

  const ctx = {
    video: {
      width: video.width,
      height: video.height,
      fps: video.fps,
      durationSec: video.durationSec,
      audioCodec: video.audioCodec,
    },
    baseCrf: request.options.baseCrf,
  };

  const jobs: Array<{
    key: string;
    degradation: OutputKind | 'original';
    level: string;
    label: string;
    summary: string;
    result: ProcessorOutput;
  }> = [
    {
      key: 'original',
      degradation: 'original',
      level: 'source',
      label: 'Original',
      // Encoded at CRF 16 so the reference clip is visually identical to source
      // and any difference the operator sees comes from the degradation.
      summary: 'untouched source, CRF 16 reference encode',
      result: { filters: [], outputArgs: [], crf: 16, params: {} },
    },
  ];

  for (const selection of request.selections) {
    if (selection.degradation === COMBINED_ID) continue;
    const definition = getDegradation(selection.degradation);
    const level = getLevel(selection.degradation, selection.level);
    const result = getProcessor(selection.degradation as Exclude<OutputKind, 'combined'>)(
      level,
      ctx,
    );
    jobs.push({
      key: `${definition.id}_${level.id}`,
      degradation: definition.id,
      level: level.id,
      label: `${definition.label} - ${level.label}`,
      summary: level.summary,
      result,
    });
  }

  if (request.combined && request.combined.steps.length >= 2) {
    const steps: CombinedStep[] = request.combined.steps.map((step) => ({
      id: step.degradation as CombinedStep['id'],
      level: getLevel(step.degradation as OutputKind, step.level),
    }));
    const result = buildCombined(steps, ctx);
    jobs.push({
      key: `combined_${request.combined.tier}`,
      degradation: COMBINED_ID,
      level: request.combined.tier,
      label: `${COMBINED_DEFINITION.label} - ${request.combined.tier}`,
      summary: String(result.params.pipeline ?? ''),
      result,
    });
  }

  const clips: PreviewClip[] = [];

  // Previews run one at a time: they are short, and the operator is waiting.
  for (const job of jobs) {
    const target = path.join(dir, `${sanitizeSegment(job.key)}_${start.toFixed(1)}s_${seconds}s.mp4`);

    if (job.result.skip) {
      clips.push({
        degradation: job.degradation,
        level: job.level,
        label: job.label,
        summary: job.summary,
        filterChain: '',
        url: '',
        sizeBytes: 0,
        error: `Not applicable to this video: ${job.result.skip}`,
      });
      continue;
    }

    try {
      const cached = await fs.stat(target).catch(() => null);
      if (!cached || cached.size === 0) {
        const args = await buildEncodeArgs({
          inputPath: video.path,
          outputPath: target,
          filters: job.result.filters,
          extraArgs: job.result.outputArgs,
          crf: job.result.crf ?? request.options.baseCrf,
          preset: request.options.encoderPreset,
          forceCfr: job.result.forceCfr ?? false,
          outputFps: job.result.outputFps,
          audioCodec: video.audioCodec,
          clip: { start, duration: seconds },
        });
        await runFfmpeg(bin, args);
      }

      const stat = await fs.stat(target);
      clips.push({
        degradation: job.degradation,
        level: job.level,
        label: job.label,
        summary: job.summary,
        filterChain: job.result.filters.join(',') || '(no filter - encoder settings only)',
        url: mediaUrl(target),
        sizeBytes: stat.size,
      });
    } catch (error) {
      clips.push({
        degradation: job.degradation,
        level: job.level,
        label: job.label,
        summary: job.summary,
        filterChain: job.result.filters.join(','),
        url: '',
        sizeBytes: 0,
        error: (error as Error).message.split(/\r?\n/).slice(-3).join(' | '),
      });
    }
  }

  return clips;
}

/** Remove every generated preview for a dataset. */
export async function clearPreviews(
  datasetRoot: string,
  customRoot?: string | null,
): Promise<void> {
  const dir = previewRoot(datasetRoot, customRoot);
  assertInside(resolveOutputRoot(datasetRoot, customRoot), dir, 'preview directory');
  await fs.rm(dir, { recursive: true, force: true });
}
