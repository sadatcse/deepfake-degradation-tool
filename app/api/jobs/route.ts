import { jobRequestSchema } from '@/lib/schemas';
import { fail, handleError, ok } from '@/server/http';
import { activeJob, createJob, listJobs } from '@/server/store';
import { requireFfmpeg } from '@/services/ffmpeg.service';
import { validateOutputRoot } from '@/utils/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/jobs - recent jobs, newest first. */
export async function GET() {
  try {
    return ok({ jobs: listJobs().map((job) => job.snapshot()) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/jobs - plan a run and start it.
 *
 * `start()` is intentionally not awaited: the request returns as soon as the
 * job exists so the UI can subscribe to the event stream, while the worker pool
 * keeps running in the background for as long as it takes.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = jobRequestSchema.safeParse(body);
  if (!parsed.success) return handleError(parsed.error);

  try {
    // Fail fast and clearly rather than starting a job that cannot encode.
    await requireFfmpeg();

    // An output folder inside a dataset would be re-scanned as input next time.
    const problem = validateOutputRoot(parsed.data.options.outputRoot, parsed.data.roots);
    if (problem) return fail(problem.message, 422, { code: problem.code });

    const existing = activeJob();
    if (existing) {
      return fail(
        `Job ${existing.id} is already ${existing.getStatus()}. Cancel it before starting another.`,
        409,
        { jobId: existing.id },
      );
    }

    const { job, taskCount } = await createJob(parsed.data);

    if (taskCount === 0) {
      return fail('Nothing to do - the selection produced no output tasks.', 400);
    }

    void job.start().catch(() => {
      // Errors are already recorded on the job and surfaced through its log.
    });

    return ok({ jobId: job.id, taskCount, snapshot: job.snapshot() }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
}
