/**
 * Tests for the on-disk metadata layer.
 *
 * metadata.json is what resume and the "same filename, different settings"
 * check both read on a later run, so the invariant that it describes files
 * which actually exist matters more than anything else written here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MetadataRecord } from '@/types';
import { mergeMetadata, readMetadataIndex, writeManifest } from '@/services/metadata.service';

function record(partial: Partial<MetadataRecord> & Pick<MetadataRecord, 'output'>): MetadataRecord {
  return {
    source: 'v1.mp4',
    sourceAbsolute: 'D:\\Dataset-01\\v1.mp4',
    degradation: 'blur',
    severity: 'medium',
    level: 'medium',
    parameters: {},
    filterChain: 'gblur=sigma=3.333:steps=2',
    status: 'completed',
    processedAt: new Date().toISOString(),
    processingMs: 100,
    originalSha256: null,
    outputSha256: null,
    sourceSizeBytes: 1000,
    outputSizeBytes: 500,
    durationSec: 3,
    width: 1920,
    height: 1080,
    fps: 30,
    codec: 'h264',
    split: null,
    error: null,
    ...partial,
  };
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ddt-meta-'));
}

test('a failed attempt never overwrites the record of an output that exists', async () => {
  const root = await tempRoot();
  try {
    // An earlier run produced this file at severity "severe".
    await mergeMetadata(root, [
      record({
        output: 'blur/v1_blur.mp4',
        level: 'severe',
        severity: 'severe',
        status: 'completed',
        outputSha256: 'abc123',
      }),
    ]);

    // A later run wants the same filename at "medium" and fails on the clash.
    await mergeMetadata(root, [
      record({
        output: 'blur/v1_blur.mp4',
        level: 'medium',
        severity: 'medium',
        status: 'failed',
        error: 'Output already exists but was produced at level "severe".',
      }),
    ]);

    const index = await readMetadataIndex(root);
    const kept = index.get('blur/v1_blur.mp4');

    assert.ok(kept);
    assert.equal(kept.status, 'completed', 'the completed record must survive');
    assert.equal(kept.level, 'severe', 'the real level of the file on disk must survive');
    assert.equal(kept.outputSha256, 'abc123', 'the real checksum must survive');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a skipped attempt never overwrites a completed record either', async () => {
  const root = await tempRoot();
  try {
    await mergeMetadata(root, [record({ output: 'blur/v1_blur.mp4', outputSha256: 'real' })]);
    await mergeMetadata(root, [
      record({ output: 'blur/v1_blur.mp4', status: 'skipped', outputSha256: null }),
    ]);

    const kept = (await readMetadataIndex(root)).get('blur/v1_blur.mp4');
    assert.equal(kept?.status, 'completed');
    assert.equal(kept?.outputSha256, 'real');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a completed record does replace an earlier failure for the same output', async () => {
  const root = await tempRoot();
  try {
    await mergeMetadata(root, [
      record({ output: 'blur/v1_blur.mp4', status: 'failed', error: 'boom', outputSha256: null }),
    ]);
    await mergeMetadata(root, [
      record({ output: 'blur/v1_blur.mp4', status: 'completed', outputSha256: 'fixed' }),
    ]);

    const kept = (await readMetadataIndex(root)).get('blur/v1_blur.mp4');
    assert.equal(kept?.status, 'completed');
    assert.equal(kept?.outputSha256, 'fixed');
    assert.equal(kept?.error, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('re-running a completed output updates it in place rather than duplicating', async () => {
  const root = await tempRoot();
  try {
    await mergeMetadata(root, [record({ output: 'blur/v1_blur.mp4', outputSha256: 'first' })]);
    const merged = await mergeMetadata(root, [
      record({ output: 'blur/v1_blur.mp4', outputSha256: 'second' }),
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].outputSha256, 'second');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('records for different outputs accumulate', async () => {
  const root = await tempRoot();
  try {
    await mergeMetadata(root, [record({ output: 'blur/v1_blur.mp4' })]);
    const merged = await mergeMetadata(root, [
      record({ output: 'noise/v1_noise.mp4', degradation: 'noise' }),
    ]);

    assert.equal(merged.length, 2);
    assert.deepEqual(
      merged.map((r) => r.output).sort(),
      ['blur/v1_blur.mp4', 'noise/v1_noise.mp4'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a corrupt metadata.json does not stop a run', async () => {
  const root = await tempRoot();
  try {
    await fs.writeFile(path.join(root, 'metadata.json'), '{ this is not json', 'utf8');

    const merged = await mergeMetadata(root, [record({ output: 'blur/v1_blur.mp4' })]);
    assert.equal(merged.length, 1, 'the run continues and rebuilds the file');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('manifest lists absolute paths and file URLs for sources and outputs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-'));
  try {
    const source = path.join(dir, 'in', 'v1.mp4');
    const target = await writeManifest(dir, {
      inputFolder: path.join(dir, 'in'),
      datasetName: 'in',
      totalVideos: 1,
      degradations: ['blur'],
      severities: ['medium'],
      options: {} as never,
      counts: { total: 1, pending: 0, running: 0, completed: 1, failed: 0, skipped: 0, cancelled: 0 },
      records: [
        record({
          output: 'random/set_1/v1_blur_medium.mp4',
          sourceAbsolute: source,
          randomSet: 1,
        }),
      ],
    });
    const manifest = JSON.parse(await fs.readFile(target, 'utf8'));
    const file = manifest.files[0];
    const out = file.outputs[0];
    const expected = path.join(dir, 'random', 'set_1', 'v1_blur_medium.mp4');

    assert.equal(manifest.outputRoot, path.resolve(dir));
    assert.equal(file.sourcePath, source);
    assert.ok(file.sourceUrl.startsWith('file:///'));
    assert.equal(out.outputPath, expected);
    assert.ok(out.outputUrl.startsWith('file:///'));
    assert.ok(out.outputUrl.endsWith('/random/set_1/v1_blur_medium.mp4'));
    assert.equal(out.randomSet, 1);
    assert.equal(out.severity, 'medium');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
