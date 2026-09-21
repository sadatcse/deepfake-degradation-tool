import type { TaskRecord, TaskStatus } from '@/types';
import { fail, handleError, ok } from '@/server/http';
import { getJob } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES = new Set<TaskStatus>([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

/**
 * GET /api/jobs/:id/tasks?status=failed&limit=100&offset=0
 *
 * Paginated because a run can hold tens of thousands of tasks and the browser
 * only ever needs the page it is showing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const job = getJob(id);
    if (!job) return fail(`No job with id ${id}.`, 404);

    const url = new URL(request.url);
    const statusParam = url.searchParams.get('status');
    const search = url.searchParams.get('q')?.toLowerCase().trim() ?? '';
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

    let tasks: readonly TaskRecord[] = job.getTasks();

    if (statusParam && STATUSES.has(statusParam as TaskStatus)) {
      tasks = tasks.filter((t) => t.status === statusParam);
    }
    if (search) {
      tasks = tasks.filter(
        (t) =>
          t.sourceRelative.toLowerCase().includes(search) ||
          t.outputRelative.toLowerCase().includes(search),
      );
    }

    const page = tasks.slice(offset, offset + limit).map((task) => ({
      id: task.id,
      datasetName: task.datasetName,
      sourceRelative: task.sourceRelative,
      outputRelative: task.outputRelative,
      degradation: task.degradation,
      level: task.level,
      severity: task.severity,
      status: task.status,
      progress: task.progress,
      error: task.error,
      skipReason: task.skipReason,
      processingMs: task.processingMs,
      outputSizeBytes: task.outputSizeBytes,
      sourceSha256: task.sourceSha256,
      outputSha256: task.outputSha256,
      filterChain: task.filterChain,
      params: task.params,
    }));

    return ok({ tasks: page, total: tasks.length, offset, limit });
  } catch (error) {
    return handleError(error);
  }
}
