import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirEntry } from '@/types';
import { SUPPORTED_EXTENSIONS } from '@/types';
import { handleError, ok } from '@/server/http';
import { assertAllowed, getAllowedRoots, isIgnoredDir, normalize } from '@/utils/paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED = new Set<string>(SUPPORTED_EXTENSIONS);

/**
 * Enumerate the top-level places a user can start browsing from.
 *
 * A browser cannot hand the server a real folder path, so the folder picker is
 * server-side: it lists the filesystem of the machine the app is running on,
 * which is the user's own machine. Nothing is uploaded anywhere.
 */
async function listRoots(): Promise<DirEntry[]> {
  const configured = getAllowedRoots();
  if (configured) {
    return configured.map((p) => ({ name: p, path: p, isDirectory: true }));
  }

  const roots: DirEntry[] = [];

  if (process.platform === 'win32') {
    // Probing A: and B: is pointless on modern machines and can stall on a
    // disconnected floppy controller, so start at C:.
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(
      letters.map(async (letter): Promise<DirEntry | null> => {
        const drive = `${letter}:\\`;
        try {
          await fs.access(drive);
          return { name: drive, path: drive, isDirectory: true };
        } catch {
          return null;
        }
      }),
    );
    roots.push(...found.filter((d): d is DirEntry => d !== null));
  } else {
    roots.push({ name: '/', path: '/', isDirectory: true });
  }

  const home = os.homedir();
  if (home && !roots.some((r) => r.path === home)) {
    roots.unshift({ name: `Home (${path.basename(home) || home})`, path: home, isDirectory: true });
  }

  return roots;
}

/** GET /api/fs/list?path=D:/Datasets - folders only, plus a video count. */
export async function GET(request: Request) {
  try {
    const raw = new URL(request.url).searchParams.get('path');
    const roots = await listRoots();

    if (!raw || raw.trim() === '') {
      return ok({ path: null, parent: null, entries: [], roots, videoFilesHere: 0 });
    }

    const target = assertAllowed(normalize(raw));

    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return ok({ path: target, parent: null, entries: [], roots, error: 'Folder not found.', videoFilesHere: 0 });
    if (!stat.isDirectory()) {
      return ok({ path: target, parent: null, entries: [], roots, error: 'Not a folder.', videoFilesHere: 0 });
    }

    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch (error) {
      return ok({
        path: target,
        parent: path.dirname(target),
        entries: [],
        roots,
        videoFilesHere: 0,
        error: `Cannot read this folder: ${(error as Error).message}`,
      });
    }

    const entries: DirEntry[] = [];
    let videoFilesHere = 0;

    for (const entry of dirents) {
      if (entry.isDirectory()) {
        // Hidden and generated folders are noise in a picker, but
        // degraded_output is shown so the user can see a processed dataset.
        if (entry.name.startsWith('.') || (isIgnoredDir(entry.name) && entry.name !== 'degraded_output')) {
          continue;
        }
        entries.push({
          name: entry.name,
          path: path.join(target, entry.name),
          isDirectory: true,
        });
      } else if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
        videoFilesHere += 1;
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));

    const parent = path.dirname(target);
    return ok({
      path: target,
      parent: parent === target ? null : parent,
      entries,
      roots,
      videoFilesHere,
    });
  } catch (error) {
    return handleError(error);
  }
}
