import { controlSchema } from '@/lib/schemas';
import { fail, handleError, ok } from '@/server/http';
import { getJob } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

/**
 * Pause / Resume / Cancel / Retry Failed / Force Reprocess / Export.
 *
 * Every one of these performs a real operation on the running engine - pause
 * stops new encodes being scheduled, cancel kills the ffmpeg processes that are
 * in flight, retry requeues only the failed tasks.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = getJob(id);
    if (!job) return fail(`No job with id ${id}.`, 404);

    const body = await request.json().catch(() => ({}));
    const parsed = controlSchema.safeParse(body);
    if (!parsed.success) return handleError(parsed.error);

    switch (parsed.data.action) {
      case 'pause':
        job.pause();
        break;

      case 'resume':
        job.resume();
        break;

      case 'cancel':
        job.cancel();
        break;

      case 'retry-failed': {
        const requeued = job.retryFailed();
        if (requeued === 0) return ok({ snapshot: job.snapshot(), requeued: 0 });
        // start() is a no-op if workers are still draining; otherwise it spins
        // the pool back up for exactly the requeued tasks.
        void job.start().catch(() => {});
        return ok({ snapshot: job.snapshot(), requeued });
      }

      case 'force-reprocess': {
        job.forceReprocessAll();
        void job.start().catch(() => {});
        break;
      }

      case 'export': {
        const files = await job.exportNow();
        return ok({ snapshot: job.snapshot(), files });
      }
    }

    return ok({ snapshot: job.snapshot() });
  } catch (error) {
    return handleError(error);
  }
}
