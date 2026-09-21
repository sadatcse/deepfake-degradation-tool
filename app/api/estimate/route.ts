import type { VideoMetadata } from '@/types';
import { estimateRequestSchema } from '@/lib/schemas';
import { getLevel } from '@/lib/degradations';
import { handleError, ok } from '@/server/http';
import { getScan } from '@/server/store';
import { planTasks } from '@/services/planner.service';
import { buildEstimate, getDiskInfo, type EstimateTaskLike } from '@/services/storage.service';
import { validateOutputRoot } from '@/utils/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Output count and disk estimate (spec 18, 37).
 *
 * Uses the same planner the engine uses, so the number shown here is the exact
 * number of files that will be produced - including the tasks the processors
 * already know to skip (an "upscale" to 720p from a 480p source, for example).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = estimateRequestSchema.safeParse(body);
  if (!parsed.success) return handleError(parsed.error);

  try {
    // Surfaced before the run so the UI can block Start with the reason.
    const problem = validateOutputRoot(parsed.data.options.outputRoot, parsed.data.roots);

    const scans = await Promise.all(parsed.data.roots.map((root) => getScan(root)));
    const plan = planTasks(parsed.data, scans);

    const byPath = new Map<string, VideoMetadata>();
    for (const scan of scans) {
      for (const video of scan.videos) byPath.set(video.path, video);
    }

    const estimateTasks: EstimateTaskLike[] = plan.tasks.map((task) => {
      const video = byPath.get(task.sourcePath);
      let levelLabel = task.level;
      try {
        levelLabel = getLevel(task.degradation, task.level).label;
      } catch {
        // `combined` levels are the tier names, which are already readable.
      }
      return {
        degradation: task.degradation,
        level: task.level,
        levelLabel: `${task.degradation} / ${levelLabel}`,
        video: video as VideoMetadata,
        params: task.params,
        crf: task.exec.crf,
        willRun: task.status === 'pending' && video !== undefined,
      };
    });

    const allVideos = scans.flatMap((s) => s.videos);
    const estimate = buildEstimate(estimateTasks, allVideos, plan.formula);

    // Free space matters on the volume being *written to*, which with a custom
    // output root may be a different drive from the input entirely.
    const outputRoots = scans.map(
      (scan) => plan.outputRootByRoot.get(scan.root) ?? scan.root,
    );
    const disks = await Promise.all(outputRoots.map((root) => getDiskInfo(root)));
    const uniqueDisks = [...new Map(disks.map((d) => [d.path, d])).values()];
    const freeBytes = uniqueDisks.reduce((sum, d) => sum + (d.ok ? d.freeBytes : 0), 0);

    const skipped = plan.tasks.filter((t) => t.status === 'skipped');

    return ok({
      estimate,
      outputRoots: [...new Set(outputRoots)],
      outputProblem: problem,
      disks: uniqueDisks,
      totalTasks: plan.tasks.length,
      skippedTasks: skipped.length,
      skippedReasons: [...new Set(skipped.map((t) => t.skipReason ?? 'skipped'))].slice(0, 8),
      // READY / TIGHT / INSUFFICIENT drives the badge in the UI.
      diskStatus:
        !uniqueDisks.some((d) => d.ok)
          ? 'UNKNOWN'
          : estimate.estimatedOutputBytes > freeBytes
            ? 'INSUFFICIENT'
            : estimate.estimatedOutputBytes > freeBytes * 0.85
              ? 'TIGHT'
              : 'READY',
      freeBytes,
    });
  } catch (error) {
    return handleError(error);
  }
}
