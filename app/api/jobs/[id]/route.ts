import { fail, handleError, ok } from '@/server/http';
import { getJob } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/jobs/:id - snapshot plus the tail of the log (polling fallback). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = getJob(id);
    if (!job) return fail(`No job with id ${id}.`, 404);

    return ok({
      snapshot: job.snapshot(),
      logs: job.getLogs().slice(-300),
    });
  } catch (error) {
    return handleError(error);
  }
}
