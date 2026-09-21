/**
 * Tests for the configurable output folder.
 *
 * The important guarantees are that the default layout is completely unchanged,
 * that a custom root keeps each dataset in its own subfolder, and that an
 * output folder which would poison the next scan is rejected up front.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { DatasetScan, JobRequest, VideoMetadata } from '@/types';
import { planTasks } from '@/services/planner.service';
import { previewRoot } from '@/services/preview.service';
import { isInside, resolveOutputRoot, validateOutputRoot } from '@/utils/paths';

function video(partial: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    path: 'D:\\Dataset-01\\video001.mp4',
    relativePath: 'video001.mp4',
    relativeDir: '',
    fileName: 'video001.mp4',
    baseName: 'video001',
    extension: '.mp4',
    sizeBytes: 1024,
    modifiedAt: new Date().toISOString(),
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    bitrateBps: 1_000_000,
    pixelFormat: 'yuv420p',
    split: null,
    probeError: null,
    ...partial,
  };
}

function scan(videos: VideoMetadata[], root: string): DatasetScan {
  return {
    root,
    name: path.basename(root),
    scannedAt: new Date().toISOString(),
    videos,
    summary: {
      root,
      totalVideos: videos.length,
      totalSizeBytes: 0,
      totalDurationSec: 0,
      unreadable: 0,
      resolutions: [],
      fpsBuckets: [],
      codecs: [],
      splits: [],
      extensions: [],
    },
    hasExistingOutput: false,
  };
}

const baseOptions: JobRequest['options'] = {
  workers: 2,
  skipExisting: true,
  forceReprocess: false,
  computeChecksums: false,
  alwaysIncludeSeverityInName: false,
  baseCrf: 18,
  encoderPreset: 'veryfast',
  combinedOrder: ['blur'],
  includeCombined: false,
  outputRoot: null,
};

function plan(roots: string[], outputRoot: string | null) {
  return planTasks(
    {
      roots,
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: { ...baseOptions, outputRoot },
    },
    roots.map((root) => scan([video({ path: path.join(root, 'video001.mp4') })], root)),
  );
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

test('no custom root keeps the original degraded_output layout', () => {
  assert.equal(
    resolveOutputRoot('D:\\Dataset-01', null),
    path.join('D:\\Dataset-01', 'degraded_output'),
  );
  assert.equal(
    resolveOutputRoot('D:\\Dataset-01', ''),
    path.join('D:\\Dataset-01', 'degraded_output'),
  );
  assert.equal(
    resolveOutputRoot('D:\\Dataset-01', undefined),
    path.join('D:\\Dataset-01', 'degraded_output'),
  );
});

test('a custom root nests each dataset under its own name', () => {
  assert.equal(
    resolveOutputRoot('D:\\Dataset-01', 'E:\\renders'),
    path.join('E:\\renders', 'Dataset-01'),
  );
  assert.equal(
    resolveOutputRoot('D:\\data\\Dataset-02', 'E:\\renders'),
    path.join('E:\\renders', 'Dataset-02'),
  );
});

test('default planning is byte-for-byte what it was before this option existed', () => {
  const result = plan(['D:\\Dataset-01'], null);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].outputRelative, 'blur/video001_blur.mp4');
  assert.equal(
    result.tasks[0].outputPath,
    path.join('D:\\Dataset-01', 'degraded_output', 'blur', 'video001_blur.mp4'),
  );
});

test('a custom root redirects the absolute path but not the relative layout', () => {
  const result = plan(['D:\\Dataset-01'], 'E:\\renders');
  assert.equal(
    result.tasks[0].outputPath,
    path.join('E:\\renders', 'Dataset-01', 'blur', 'video001_blur.mp4'),
  );
  // outputRelative is what metadata.json records, and stays root-relative.
  assert.equal(result.tasks[0].outputRelative, 'blur/video001_blur.mp4');
  assert.equal(result.tasks[0].outputRoot, path.join('E:\\renders', 'Dataset-01'));
});

test('several datasets stay separated under one custom root', () => {
  const result = plan(['D:\\Dataset-01', 'D:\\Dataset-02'], 'E:\\renders');

  const paths = result.tasks.map((t) => t.outputPath).sort();
  assert.deepEqual(paths, [
    path.join('E:\\renders', 'Dataset-01', 'blur', 'video001_blur.mp4'),
    path.join('E:\\renders', 'Dataset-02', 'blur', 'video001_blur.mp4'),
  ]);
  assert.equal(new Set(paths).size, 2, 'datasets must not collide');

  assert.equal(result.outputRootByRoot.size, 2);
  assert.equal(
    result.outputRootByRoot.get('D:\\Dataset-01'),
    path.join('E:\\renders', 'Dataset-01'),
  );
});

test('every task stays inside its own resolved output root', () => {
  for (const custom of [null, 'E:\\renders']) {
    const result = plan(['D:\\Dataset-01', 'D:\\Dataset-02'], custom);
    for (const task of result.tasks) {
      assert.ok(
        isInside(task.outputRoot, task.outputPath),
        `task escaped its output root (custom=${custom}): ${task.outputPath}`,
      );
    }
  }
});

test('nested source folders are preserved under a custom root', () => {
  const root = 'D:\\Dataset-01';
  const nested = video({
    path: path.join(root, 'train', 'real', 'v1.mp4'),
    relativePath: 'train/real/v1.mp4',
    relativeDir: 'train/real',
    fileName: 'v1.mp4',
    baseName: 'v1',
    split: 'train',
  });

  const result = planTasks(
    {
      roots: [root],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: { ...baseOptions, outputRoot: 'E:\\renders' },
    },
    [scan([nested], root)],
  );

  assert.equal(
    result.tasks[0].outputPath,
    path.join('E:\\renders', 'Dataset-01', 'blur', 'train', 'real', 'v1_blur.mp4'),
  );
});

test('previews follow the configured output root', () => {
  assert.equal(
    previewRoot('D:\\Dataset-01', null),
    path.join('D:\\Dataset-01', 'degraded_output', '.previews'),
  );
  assert.equal(
    previewRoot('D:\\Dataset-01', 'E:\\renders'),
    path.join('E:\\renders', 'Dataset-01', '.previews'),
  );
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

test('a blank output root is always allowed', () => {
  assert.equal(validateOutputRoot(null, ['D:\\Dataset-01']), null);
  assert.equal(validateOutputRoot('', ['D:\\Dataset-01']), null);
});

test('a separate output root is allowed', () => {
  assert.equal(validateOutputRoot('E:\\renders', ['D:\\Dataset-01', 'D:\\Dataset-02']), null);
});

test('an output folder inside a dataset is rejected', () => {
  // This is the dangerous one: the scanner only skips "degraded_output", so
  // output anywhere else under the dataset returns as input on the next scan.
  const problem = validateOutputRoot('D:\\Dataset-01\\renders', ['D:\\Dataset-01']);
  assert.equal(problem?.code, 'inside-input');
  assert.match(String(problem?.message), /pick those generated videos up as new input/);
});

test('an output folder equal to a dataset is rejected', () => {
  const problem = validateOutputRoot('D:\\Dataset-01', ['D:\\Dataset-01']);
  assert.equal(problem?.code, 'same-as-input');
});

test('an output folder enclosing a dataset is rejected', () => {
  const problem = validateOutputRoot('D:\\data', ['D:\\data\\Dataset-01']);
  assert.equal(problem?.code, 'contains-input');
});

test('two datasets with the same folder name are rejected under a custom root', () => {
  const problem = validateOutputRoot('E:\\renders', ['D:\\a\\videos', 'D:\\b\\videos']);
  assert.equal(problem?.code, 'name-collision');
  assert.match(String(problem?.message), /videos/);
});

test('same-named datasets are fine with the default layout', () => {
  // Each keeps its output beside itself, so there is nothing to collide.
  assert.equal(validateOutputRoot(null, ['D:\\a\\videos', 'D:\\b\\videos']), null);
});

test('a sibling folder with a shared prefix is not treated as nested', () => {
  assert.equal(validateOutputRoot('D:\\Dataset-01-out', ['D:\\Dataset-01']), null);
});
