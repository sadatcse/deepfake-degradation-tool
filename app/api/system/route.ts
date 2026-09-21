import { getSystemInfo } from '@/services/ffmpeg.service';
import { handleError, ok } from '@/server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * FFmpeg / FFprobe detection (spec 45). `?refresh=1` re-runs detection, so the
 * user can install ffmpeg and click Re-check without restarting the app.
 */
export async function GET(request: Request) {
  try {
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    return ok(await getSystemInfo(force));
  } catch (error) {
    return handleError(error);
  }
}
