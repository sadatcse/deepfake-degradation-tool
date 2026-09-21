import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fail, handleError } from '@/server/http';
import { listOutputRoots, listScans } from '@/server/store';
import { OUTPUT_DIR_NAME, isInside, normalize } from '@/utils/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/**
 * Serve a generated file back to the page for playback.
 *
 * The boundary is deliberately narrow: only files inside the
 * `degraded_output/` folder of a dataset that has actually been scanned in this
 * session can be read. Source videos are never served, and no path outside a
 * known output folder is reachable even if one is guessed.
 */
function isServable(target: string): boolean {
  // Default layout: degraded_output inside a dataset scanned this session.
  if (listScans().some((scan) => isInside(path.join(scan.root, OUTPUT_DIR_NAME), target))) {
    return true;
  }
  // Custom output root, registered when the job or preview was created.
  return listOutputRoots().some((root) => isInside(root, target));
}

export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get('path');
    if (!raw) return fail('A path is required.', 400);

    const target = normalize(raw);
    if (!isServable(target)) {
      return fail('This file is outside every scanned output folder.', 403);
    }

    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) return fail('File not found.', 404);

    const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    const size = stat.size;

    const headers = new Headers({
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });

    // Seeking in a <video> element needs byte-range support.
    const range = request.headers.get('range');
    const match = range?.match(/^bytes=(\d*)-(\d*)$/);

    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];

      let start = startRaw === '' ? 0 : Number(startRaw);
      let end = endRaw === '' ? size - 1 : Number(endRaw);

      if (startRaw === '' && endRaw !== '') {
        // Suffix form: "bytes=-500" means the last 500 bytes.
        start = Math.max(0, size - Number(endRaw));
        end = size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }

      end = Math.min(end, size - 1);
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));

      const stream = Readable.toWeb(
        createReadStream(target, { start, end }),
      ) as unknown as ReadableStream;
      return new Response(stream, { status: 206, headers });
    }

    headers.set('Content-Length', String(size));
    const stream = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers });
  } catch (error) {
    return handleError(error);
  }
}
