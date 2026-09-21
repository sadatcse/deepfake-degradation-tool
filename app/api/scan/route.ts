import { scanRequestSchema } from '@/lib/schemas';
import { handleError, ok } from '@/server/http';
import { putScan, peekScan } from '@/server/store';
import { markScanFailed, scanDataset } from '@/services/scanner.service';
import { getDiskInfo } from '@/services/storage.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// A folder with tens of thousands of videos takes a while to probe.
export const maxDuration = 3600;

/**
 * Scan a dataset folder.
 *
 * The full per-video metadata stays on the server (see server/store.ts); the
 * response carries the summary plus a capped sample of rows, so the browser is
 * not asked to hold 10,000 objects it cannot use.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = scanRequestSchema.safeParse(body);
  if (!parsed.success) return handleError(parsed.error);

  const { root, force, token } = parsed.data;

  try {
    const cached = force ? null : peekScan(root);
    const scan = cached ?? (await scanDataset(root, { token }));
    if (!cached) putScan(scan);

    const disk = await getDiskInfo(scan.root);

    return ok({
      root: scan.root,
      name: scan.name,
      scannedAt: scan.scannedAt,
      summary: scan.summary,
      hasExistingOutput: scan.hasExistingOutput,
      cached: cached !== null,
      disk,
      // Enough rows for the metadata table without shipping the whole dataset.
      videos: scan.videos.slice(0, 500),
      videoCount: scan.videos.length,
      truncated: scan.videos.length > 500,
    });
  } catch (error) {
    markScanFailed(token, (error as Error).message);
    return handleError(error);
  }
}
