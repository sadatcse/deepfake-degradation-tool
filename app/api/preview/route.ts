import { previewRequestSchema } from '@/lib/schemas';
import { handleError, ok } from '@/server/http';
import { getScan, registerOutputRoot } from '@/server/store';
import { clearPreviews, generatePreviews, previewRoot } from '@/services/preview.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 600;

/** Generate sample clips so settings can be confirmed before a bulk run (spec 17). */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = previewRequestSchema.safeParse(body);
  if (!parsed.success) return handleError(parsed.error);

  try {
    const scan = await getScan(parsed.data.root);
    // Previews may land under a custom output root, which /api/media only
    // serves from once it has been registered.
    registerOutputRoot(previewRoot(scan.root, parsed.data.options.outputRoot));
    const clips = await generatePreviews(scan, parsed.data);
    return ok({ clips, video: parsed.data.video, seconds: parsed.data.seconds });
  } catch (error) {
    return handleError(error);
  }
}

/** Discard generated previews for a dataset. */
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const root = url.searchParams.get('root');
    if (!root) return handleError(new Error('A root folder is required.'));
    const scan = await getScan(root);
    await clearPreviews(scan.root, url.searchParams.get('outputRoot'));
    return ok({ cleared: true });
  } catch (error) {
    return handleError(error);
  }
}
