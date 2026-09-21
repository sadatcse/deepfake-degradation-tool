import { getDiskInfo } from '@/services/storage.service';
import { handleError, ok } from '@/server/http';
import { assertAllowed } from '@/utils/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Disk total/used/available for the volume holding `?path=` (spec 38). */
export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get('path');
    if (!raw) return ok({ disks: [] });

    const paths = raw.split('|').filter(Boolean);
    const disks = await Promise.all(
      paths.map(async (p) => {
        try {
          return await getDiskInfo(assertAllowed(p));
        } catch (error) {
          return {
            path: p,
            totalBytes: 0,
            freeBytes: 0,
            usedBytes: 0,
            ok: false,
            error: (error as Error).message,
          };
        }
      }),
    );

    // One entry per distinct volume - several datasets often share a drive.
    const unique = new Map(disks.map((d) => [d.path, d]));
    return ok({ disks: [...unique.values()] });
  } catch (error) {
    return handleError(error);
  }
}
