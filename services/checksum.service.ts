/**
 * SHA-256 checksums for data lineage.
 *
 * Hashing is streamed, never buffered, so a 4 GB source costs a 1 MB read
 * buffer. Source hashes are memoised per (path, size, mtime): a video degraded
 * eleven ways is only hashed once per run.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

interface CacheEntry {
  hash: string;
  size: number;
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry>();

/** Keep the cache from growing without bound on very large datasets. */
const MAX_CACHE_ENTRIES = 5000;

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath, { highWaterMark: 1024 * 1024 }), hash);
  return hash.digest('hex');
}

/**
 * Hash a file, reusing a previous result when size and mtime are unchanged.
 * Returns null instead of throwing when the file cannot be read - a missing
 * checksum should never fail an otherwise good encode.
 */
export async function sha256Cached(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    const hit = cache.get(filePath);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      return hit.hash;
    }

    const hash = await sha256File(filePath);

    if (cache.size >= MAX_CACHE_ENTRIES) {
      // Cheap eviction: drop the oldest insertion.
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(filePath, { hash, size: stat.size, mtimeMs: stat.mtimeMs });
    return hash;
  } catch {
    return null;
  }
}

export function clearChecksumCache(): void {
  cache.clear();
}
