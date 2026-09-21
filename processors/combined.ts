import type { DegradationId, DegradationLevel } from '@/types';
import type { ProcessorContext, ProcessorOutput } from './types';
import { getProcessor } from './registry';

export interface CombinedStep {
  id: DegradationId;
  level: DegradationLevel;
}

/**
 * Combined degradation.
 *
 * Runs each selected degradation's processor in the order the user configured
 * and concatenates the results into a single filter chain, so the source is
 * decoded and encoded exactly once instead of once per stage. Encoder-level
 * settings are merged rather than concatenated:
 *
 *   - CRF  - a `compression` stage wins; otherwise the job's base CRF is used.
 *   - FPS  - an explicit `fps_reduction` target wins over a frame-drop's
 *            "keep the source rate" hint.
 *   - CFR  - forced as soon as any stage needs it (frame drop).
 *
 * Stages that report a skip (an upscale that would not be a degradation, for
 * instance) are dropped from the chain and recorded, instead of failing the
 * whole combined output.
 */
export function buildCombined(
  steps: readonly CombinedStep[],
  ctx: ProcessorContext,
): ProcessorOutput {
  const filters: string[] = [];
  const outputArgs: string[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  const stageParams: Record<string, unknown> = {};

  let crf: number | undefined;
  let forceCfr = false;
  let fpsTarget: number | undefined;
  let frameDropFps: number | undefined;

  for (const step of steps) {
    const out = getProcessor(step.id)(step.level, ctx);
    stageParams[step.id] = { level: step.level.id, ...out.params };

    if (out.skip) {
      skipped.push(`${step.id}: ${out.skip}`);
      continue;
    }

    filters.push(...out.filters);
    outputArgs.push(...out.outputArgs);
    applied.push(step.id);

    if (out.crf !== undefined) crf = out.crf;
    if (out.forceCfr) forceCfr = true;
    if (out.outputFps !== undefined) {
      if (step.id === 'fps_reduction') fpsTarget = out.outputFps;
      else frameDropFps = out.outputFps;
    }
  }

  if (applied.length === 0) {
    return {
      filters: [],
      outputArgs: [],
      skip:
        skipped.length > 0
          ? `every stage was skipped for this source (${skipped.join('; ')})`
          : 'no degradations selected',
      params: { pipeline: steps.map((s) => s.id).join(' -> '), stages: stageParams },
    };
  }

  return {
    filters,
    outputArgs,
    crf,
    forceCfr,
    outputFps: fpsTarget ?? frameDropFps,
    params: {
      pipeline: applied.join(' -> '),
      requestedPipeline: steps.map((s) => s.id).join(' -> '),
      stageCount: applied.length,
      skippedStages: skipped.length > 0 ? skipped : undefined,
      stages: stageParams,
    },
  };
}
