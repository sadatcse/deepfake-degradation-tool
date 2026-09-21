import { handleError, ok } from '@/server/http';
import { getScanProgress } from '@/services/scanner.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Polled by the UI while a scan POST is still in flight. */
export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get('token');
    if (!token) return ok({ progress: null });
    return ok({ progress: getScanProgress(token) });
  } catch (error) {
    return handleError(error);
  }
}
