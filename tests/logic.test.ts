/**
 * Logic tests for the parts of the tool that must be right before a single
 * frame is encoded: the filter chains, the planner's output layout and naming,
 * and the path containment rules.
 *
 * These deliberately do not require ffmpeg to be installed - they exercise the
 * pure functions that decide what ffmpeg will be asked to do.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import type { DatasetScan, JobRequest, VideoMetadata } from '@/types';
import { getLevel } from '@/lib/degradations';
import { buildCombined, getProcessor } from '@/processors';
import type { ProcessorContext } from '@/processors';
import { planTasks } from '@/services/planner.service';
import { estimateOutputBytes } from '@/services/storage.service';
import { toCsv } from '@/utils/csv';
import { isInside, sanitizeSegment } from '@/utils/paths';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function video(partial: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    path: 'D:\\Dataset-01\\video001.mp4',
    relativePath: 'video001.mp4',
    relativeDir: '',
    fileName: 'video001.mp4',
    baseName: 'video001',
    extension: '.mp4',
    sizeBytes: 50 * 1024 * 1024,
    modifiedAt: new Date().toISOString(),
    durationSec: 60,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    bitrateBps: 6_000_000,
    pixelFormat: 'yuv420p',
    split: null,
    probeError: null,
    ...partial,
  };
}

function ctx(partial: Partial<VideoMetadata> = {}): ProcessorContext {
  const v = video(partial);
  return {
    video: {
      width: v.width,
      height: v.height,
      fps: v.fps,
      durationSec: v.durationSec,
      audioCodec: v.audioCodec,
    },
    baseCrf: 18,
  };
}

function scan(videos: VideoMetadata[], root = 'D:\\Dataset-01'): DatasetScan {
  return {
    root,
    name: path.basename(root),
    scannedAt: new Date().toISOString(),
    videos,
    summary: {
      root,
      totalVideos: videos.length,
      totalSizeBytes: videos.reduce((s, v) => s + v.sizeBytes, 0),
      totalDurationSec: videos.reduce((s, v) => s + (v.durationSec ?? 0), 0),
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
  combinedOrder: ['blur', 'noise', 'compression'],
  includeCombined: false,
  outputRoot: null,
};

/* -------------------------------------------------------------------------- */
/* Processors                                                                 */
/* -------------------------------------------------------------------------- */

test('blur maps radius to sigma and scales steps with severity', () => {
  const mild = getProcessor('blur')(getLevel('blur', 'mild'), ctx());
  const severe = getProcessor('blur')(getLevel('blur', 'severe'), ctx());

  assert.equal(mild.filters[0], 'gblur=sigma=1.667:steps=1');
  assert.equal(severe.filters[0], 'gblur=sigma=6.667:steps=3');
  assert.equal(mild.params.radius, 5);
  assert.equal(severe.params.radius, 20);
});

test('blur sigma is clamped so tiny sources do not become flat colour', () => {
  const tiny = getProcessor('blur')(getLevel('blur', 'severe'), ctx({ width: 64, height: 64 }));
  // 64 / 8 = 8 is the cap, and 20/3 = 6.667 is below it, so nothing is clamped.
  assert.equal(tiny.params.sigma, 6.667);

  const tinier = getProcessor('blur')(getLevel('blur', 'severe'), ctx({ width: 32, height: 24 }));
  assert.equal(tinier.params.sigma, 3);
  assert.equal(tinier.params.requestedSigma, 6.667);
});

test('compression overrides CRF and adds no video filter', () => {
  const medium = getProcessor('compression')(getLevel('compression', 'medium'), ctx());
  assert.equal(medium.crf, 34);
  assert.deepEqual(medium.filters, []);
});

test('low resolution targets the short side and keeps aspect ratio', () => {
  const landscape = getProcessor('low_resolution')(
    getLevel('low_resolution', '480p'),
    ctx({ width: 1920, height: 1080 }),
  );
  // 1080 -> 480 is a 0.4444 factor; 1920 * 480/1080 = 853.3 -> 854 (even).
  assert.equal(landscape.filters[0], 'scale=854:480:flags=bicubic');

  const portrait = getProcessor('low_resolution')(
    getLevel('low_resolution', '480p'),
    ctx({ width: 1080, height: 1920 }),
  );
  assert.equal(portrait.filters[0], 'scale=480:854:flags=bicubic');
});

test('low resolution never upscales', () => {
  const alreadySmall = getProcessor('low_resolution')(
    getLevel('low_resolution', '720p'),
    ctx({ width: 640, height: 360 }),
  );
  assert.ok(alreadySmall.skip, 'a 360p source asked for 720p must be skipped');
  assert.match(String(alreadySmall.skip), /never upscaled/);
  assert.deepEqual(alreadySmall.filters, []);
});

test('low resolution falls back to a clamped expression without probe data', () => {
  const unknown = getProcessor('low_resolution')(
    getLevel('low_resolution', '360p'),
    ctx({ width: null, height: null }),
  );
  assert.match(unknown.filters[0], /min\(360,i[wh]\)/);
  assert.ok(!unknown.skip);
});

test('all produced dimensions are even', () => {
  const awkward = [
    [1921, 1081],
    [1003, 563],
    [641, 481],
  ] as const;

  for (const [w, h] of awkward) {
    for (const level of ['720p', '480p', '360p', '240p']) {
      const out = getProcessor('low_resolution')(
        getLevel('low_resolution', level),
        ctx({ width: w, height: h }),
      );
      if (out.skip) continue;
      const match = out.filters[0].match(/^scale=(\d+):(\d+):/);
      assert.ok(match, `expected literal scale for ${w}x${h} @ ${level}`);
      assert.equal(Number(match![1]) % 2, 0, `width odd for ${w}x${h} @ ${level}`);
      assert.equal(Number(match![2]) % 2, 0, `height odd for ${w}x${h} @ ${level}`);
    }
  }
});

test('fps reduction never increases frame rate', () => {
  const down = getProcessor('fps_reduction')(getLevel('fps_reduction', '15fps'), ctx({ fps: 30 }));
  assert.equal(down.filters[0], 'fps=15');
  assert.equal(down.outputFps, 15);

  const up = getProcessor('fps_reduction')(getLevel('fps_reduction', '30fps'), ctx({ fps: 24 }));
  assert.ok(up.skip, 'a 24fps source asked for 30fps must be skipped');
  assert.match(String(up.skip), /never upscaled/);
});

test('frame drop selector drops exactly the requested share, evenly spread', () => {
  // Mirrors select='gte(mod(n*P,100),P)' from processors/frameDrop.ts.
  const keeps = (n: number, percent: number) => (n * percent) % 100 >= percent;

  for (const percent of [5, 10, 20, 30]) {
    const total = 10_000;
    let dropped = 0;
    for (let n = 0; n < total; n += 1) if (!keeps(n, percent)) dropped += 1;

    const rate = (dropped / total) * 100;
    assert.equal(
      Math.round(rate),
      percent,
      `expected ~${percent}% dropped, measured ${rate.toFixed(2)}%`,
    );

    // No long burst of consecutive drops: losses must be spread out.
    let run = 0;
    let longestRun = 0;
    for (let n = 0; n < total; n += 1) {
      run = keeps(n, percent) ? 0 : run + 1;
      longestRun = Math.max(longestRun, run);
    }
    assert.ok(longestRun <= 2, `drops bunched up for ${percent}% (run of ${longestRun})`);
  }
});

test('frame drop preserves duration by forcing constant frame rate', () => {
  const out = getProcessor('frame_drop')(getLevel('frame_drop', '10pct'), ctx({ fps: 30 }));
  assert.equal(out.forceCfr, true);
  assert.equal(out.outputFps, 30);
  assert.match(out.filters[0], /^select='gte\(mod\(n\*10,100\),10\)'$/);
});

test('eq-based degradations emit the documented values', () => {
  assert.equal(
    getProcessor('brightness')(getLevel('brightness', 'medium'), ctx()).filters[0],
    'eq=brightness=-0.25',
  );
  assert.equal(
    getProcessor('contrast')(getLevel('contrast', 'severe'), ctx()).filters[0],
    'eq=contrast=0.45',
  );
  assert.equal(
    getProcessor('saturation')(getLevel('saturation', 'mild'), ctx()).filters[0],
    'eq=saturation=0.75',
  );
});

test('noise is seeded so runs are reproducible', () => {
  const a = getProcessor('noise')(getLevel('noise', 'medium'), ctx());
  const b = getProcessor('noise')(getLevel('noise', 'medium'), ctx());
  assert.equal(a.filters[0], b.filters[0]);
  assert.match(a.filters[0], /all_seed=\d+/);
});

/* -------------------------------------------------------------------------- */
/* Combined                                                                   */
/* -------------------------------------------------------------------------- */

test('combined chains filters in order and takes CRF from the compression stage', () => {
  const out = buildCombined(
    [
      { id: 'blur', level: getLevel('blur', 'medium') },
      { id: 'noise', level: getLevel('noise', 'medium') },
      { id: 'compression', level: getLevel('compression', 'medium') },
    ],
    ctx(),
  );

  assert.equal(out.filters.length, 2, 'compression contributes no filter');
  assert.match(out.filters[0], /^gblur/);
  assert.match(out.filters[1], /^noise/);
  assert.equal(out.crf, 34);
  assert.equal(out.params.pipeline, 'blur -> noise -> compression');
});

test('combined drops inapplicable stages instead of failing the output', () => {
  const out = buildCombined(
    [
      { id: 'blur', level: getLevel('blur', 'mild') },
      // 720p asked of a 360p source - not a degradation, so it is dropped.
      { id: 'low_resolution', level: getLevel('low_resolution', '720p') },
    ],
    ctx({ width: 640, height: 360 }),
  );

  assert.ok(!out.skip, 'the combined output should still be produced');
  assert.equal(out.filters.length, 1);
  assert.equal(out.params.pipeline, 'blur');
  assert.ok(Array.isArray(out.params.skippedStages));
});

test('combined skips entirely when no stage applies', () => {
  const out = buildCombined(
    [
      { id: 'low_resolution', level: getLevel('low_resolution', '720p') },
      { id: 'fps_reduction', level: getLevel('fps_reduction', '30fps') },
    ],
    ctx({ width: 640, height: 360, fps: 24 }),
  );
  assert.ok(out.skip);
});

test('explicit fps target wins over the frame-drop rate hint', () => {
  const out = buildCombined(
    [
      { id: 'frame_drop', level: getLevel('frame_drop', '10pct') },
      { id: 'fps_reduction', level: getLevel('fps_reduction', '15fps') },
    ],
    ctx({ fps: 30 }),
  );
  assert.equal(out.outputFps, 15);
  assert.equal(out.forceCfr, true);
});

/* -------------------------------------------------------------------------- */
/* Planner                                                                    */
/* -------------------------------------------------------------------------- */

test('planner names a single-severity output exactly as the spec shows', () => {
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: baseOptions,
    },
    [scan([video()])],
  );

  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].outputRelative, 'blur/video001_blur.mp4');
});

test('planner disambiguates filenames when several levels are queued', () => {
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['mild', 'medium', 'severe'] },
      options: baseOptions,
    },
    [scan([video()])],
  );

  const names = plan.tasks.map((t) => t.outputRelative).sort();
  assert.deepEqual(names, [
    'blur/video001_blur_medium.mp4',
    'blur/video001_blur_mild.mp4',
    'blur/video001_blur_severe.mp4',
  ]);
  assert.equal(new Set(names).size, 3, 'output names must be unique');
});

test('alwaysIncludeSeverityInName forces the long form', () => {
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: { ...baseOptions, alwaysIncludeSeverityInName: true },
    },
    [scan([video()])],
  );
  assert.equal(plan.tasks[0].outputRelative, 'blur/video001_blur_medium.mp4');
});

test('planner preserves the source folder layout under each degradation', () => {
  const videos = [
    video({
      path: 'D:\\Dataset-01\\real\\v1.mp4',
      relativePath: 'real/v1.mp4',
      relativeDir: 'real',
      fileName: 'v1.mp4',
      baseName: 'v1',
    }),
    video({
      path: 'D:\\Dataset-01\\fake\\v2.mp4',
      relativePath: 'fake/v2.mp4',
      relativeDir: 'fake',
      fileName: 'v2.mp4',
      baseName: 'v2',
    }),
  ];

  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: baseOptions,
    },
    [scan(videos)],
  );

  const outputs = plan.tasks.map((t) => t.outputRelative).sort();
  assert.deepEqual(outputs, ['blur/fake/v2_blur.mp4', 'blur/real/v1_blur.mp4']);
});

test('train/validation/test splits stay separate', () => {
  const videos = ['train', 'validation', 'test'].map((split) =>
    video({
      path: `D:\\Dataset-01\\${split}\\real\\v.mp4`,
      relativePath: `${split}/real/v.mp4`,
      relativeDir: `${split}/real`,
      split: split as VideoMetadata['split'],
    }),
  );

  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['noise'],
      levels: { noise: ['medium'] },
      options: baseOptions,
    },
    [scan(videos)],
  );

  const outputs = plan.tasks.map((t) => t.outputRelative).sort();
  assert.deepEqual(outputs, [
    'noise/test/real/video001_noise.mp4',
    'noise/train/real/video001_noise.mp4',
    'noise/validation/real/video001_noise.mp4',
  ]);
});

test('every output path stays inside the dataset output folder', () => {
  const nasty = video({
    path: 'D:\\Dataset-01\\weird\\..\\ok.mp4',
    relativePath: 'weird/ok.mp4',
    relativeDir: 'weird',
    baseName: '../../escape',
    fileName: 'ok.mp4',
  });

  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: baseOptions,
    },
    [scan([nasty])],
  );

  const outputRoot = path.join('D:\\Dataset-01', 'degraded_output');
  for (const task of plan.tasks) {
    assert.ok(
      isInside(outputRoot, task.outputPath),
      `output escaped the sandbox: ${task.outputPath}`,
    );
  }
});

test('the 1000 x 3 x 3 arithmetic from the spec holds', () => {
  const videos = Array.from({ length: 1000 }, (_, i) =>
    video({
      path: `D:\\Dataset-01\\v${i}.mp4`,
      relativePath: `v${i}.mp4`,
      baseName: `v${i}`,
      fileName: `v${i}.mp4`,
    }),
  );

  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur', 'noise', 'compression'],
      levels: {
        blur: ['mild', 'medium', 'severe'],
        noise: ['mild', 'medium', 'severe'],
        compression: ['mild', 'medium', 'severe'],
      },
      options: baseOptions,
    },
    [scan(videos)],
  );

  assert.equal(plan.tasks.length, 9000);
  assert.equal(new Set(plan.tasks.map((t) => t.outputPath)).size, 9000);
});

test('combined adds one output per severity tier', () => {
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur', 'noise'],
      levels: { blur: ['mild', 'severe'], noise: ['mild', 'severe'] },
      options: { ...baseOptions, includeCombined: true, combinedOrder: ['blur', 'noise'] },
    },
    [scan([video()])],
  );

  const combined = plan.tasks.filter((t) => t.degradation === 'combined');
  assert.equal(combined.length, 2, 'mild and severe');
  assert.deepEqual(
    combined.map((t) => t.outputRelative).sort(),
    ['combined/video001_combined_mild.mp4', 'combined/video001_combined_severe.mp4'],
  );
});

test('unreadable sources are planned as skipped, not as failures', () => {
  const broken = video({ probeError: 'No video stream found in this file.' });
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: baseOptions,
    },
    [scan([broken])],
  );

  assert.equal(plan.tasks[0].status, 'skipped');
  assert.match(String(plan.tasks[0].skipReason), /unreadable/);
});

test('multiple dataset roots each get their own output tree', () => {
  const plan = planTasks(
    {
      roots: ['D:\\Dataset-01', 'D:\\Dataset-02'],
      degradations: ['blur'],
      levels: { blur: ['medium'] },
      options: baseOptions,
    },
    [
      scan([video()], 'D:\\Dataset-01'),
      scan([video({ path: 'D:\\Dataset-02\\video001.mp4' })], 'D:\\Dataset-02'),
    ],
  );

  assert.equal(plan.tasks.length, 2);
  assert.ok(plan.tasks[0].outputPath.startsWith(path.join('D:\\Dataset-01', 'degraded_output')));
  assert.ok(plan.tasks[1].outputPath.startsWith(path.join('D:\\Dataset-02', 'degraded_output')));
});

/* -------------------------------------------------------------------------- */
/* Path containment                                                           */
/* -------------------------------------------------------------------------- */

test('isInside rejects traversal and sibling paths', () => {
  assert.equal(isInside('D:\\data', 'D:\\data\\a\\b.mp4'), true);
  assert.equal(isInside('D:\\data', 'D:\\data'), true);
  assert.equal(isInside('D:\\data', 'D:\\data\\..\\secret.mp4'), false);
  assert.equal(isInside('D:\\data', 'D:\\database\\x.mp4'), false);
  assert.equal(isInside('D:\\data', 'C:\\Windows\\win.ini'), false);
});

test('sanitizeSegment strips characters illegal in a filename', () => {
  assert.equal(sanitizeSegment('a/b\\c:d*e?f'), 'a_b_c_d_e_f');
  assert.equal(sanitizeSegment('trailing.'), 'trailing');
});

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

test('CSV quotes commas, quotes and newlines', () => {
  const csv = toCsv(['a', 'b'], [['plain', 'has,comma'], ['has"quote', 'has\nnewline']]);
  assert.match(csv, /"has,comma"/);
  assert.match(csv, /"has""quote"/);
  assert.match(csv, /"has\nnewline"/);
});

test('estimate responds to CRF, resolution and degradation type', () => {
  const source = video();
  const mild = estimateOutputBytes({
    video: source,
    degradation: 'compression',
    params: {},
    crf: 28,
  });
  const severe = estimateOutputBytes({
    video: source,
    degradation: 'compression',
    params: {},
    crf: 40,
  });
  assert.ok(severe < mild, 'a higher CRF must estimate smaller');

  const small = estimateOutputBytes({
    video: source,
    degradation: 'low_resolution',
    params: { outputWidth: 640, outputHeight: 360 },
    crf: 18,
  });
  const full = estimateOutputBytes({
    video: source,
    degradation: 'low_resolution',
    params: {},
    crf: 18,
  });
  assert.ok(small < full, 'fewer pixels must estimate smaller');

  const blurred = estimateOutputBytes({ video: source, degradation: 'blur', params: {}, crf: 18 });
  const noisy = estimateOutputBytes({ video: source, degradation: 'noise', params: {}, crf: 18 });
  assert.ok(noisy > blurred, 'noise is far more expensive to encode than blur');
});

/* -------------------------------------------------------------------------- */
/* Formula                                                                    */
/* -------------------------------------------------------------------------- */

test('the displayed formula always multiplies out to the real total', () => {
  const videos = Array.from({ length: 6 }, (_, i) =>
    video({
      path: `D:\Dataset-01\v${i}.mp4`,
      relativePath: `v${i}.mp4`,
      baseName: `v${i}`,
      fileName: `v${i}.mp4`,
    }),
  );

  const cases: Array<{ request: JobRequest; label: string }> = [
    {
      label: 'uniform, no combined',
      request: {
        roots: ['D:\Dataset-01'],
        degradations: ['blur', 'noise', 'compression'],
        levels: {
          blur: ['mild', 'medium', 'severe'],
          noise: ['mild', 'medium', 'severe'],
          compression: ['mild', 'medium', 'severe'],
        },
        options: baseOptions,
      },
    },
    {
      label: 'uniform, with combined',
      request: {
        roots: ['D:\Dataset-01'],
        degradations: ['blur', 'noise'],
        levels: { blur: ['mild', 'severe'], noise: ['mild', 'severe'] },
        options: { ...baseOptions, includeCombined: true, combinedOrder: ['blur', 'noise'] },
      },
    },
    {
      label: 'mixed level counts, with combined',
      request: {
        roots: ['D:\Dataset-01'],
        degradations: ['blur', 'noise', 'compression'],
        levels: { blur: ['mild', 'medium', 'severe'], noise: ['medium'], compression: ['mild'] },
        options: {
          ...baseOptions,
          includeCombined: true,
          combinedOrder: ['blur', 'noise', 'compression'],
        },
      },
    },
  ];

  for (const { request, label } of cases) {
    const plan = planTasks(request, [scan(videos)]);
    const match = plan.formula.match(/=\s*(\d+)\s*outputs$/);
    assert.ok(match, `no total in formula for "${label}": ${plan.formula}`);
    assert.equal(
      Number(match![1]),
      plan.tasks.length,
      `formula total disagrees with the plan for "${label}": ${plan.formula}`,
    );

    // Every "a x b x c" chain stated before the "=" must evaluate to the total.
    const lhs = plan.formula.split('=')[0];
    const factors = lhs.match(/\d+(?=\s*(?:x|$))/g);
    if (factors && !lhs.includes('(')) {
      const product = factors.reduce((a, b) => a * Number(b), 1);
      assert.equal(product, plan.tasks.length, `product wrong for "${label}": ${plan.formula}`);
    }
  }
});

test('the spec formula reads exactly as documented', () => {
  const videos = Array.from({ length: 1000 }, (_, i) =>
    video({
      path: `D:\Dataset-01\v${i}.mp4`,
      relativePath: `v${i}.mp4`,
      baseName: `v${i}`,
      fileName: `v${i}.mp4`,
    }),
  );

  const plan = planTasks(
    {
      roots: ['D:\Dataset-01'],
      degradations: ['blur', 'noise', 'compression'],
      levels: {
        blur: ['mild', 'medium', 'severe'],
        noise: ['mild', 'medium', 'severe'],
        compression: ['mild', 'medium', 'severe'],
      },
      options: baseOptions,
    },
    [scan(videos)],
  );

  assert.equal(plan.formula, '1000 videos x 3 degradations x 3 severities = 9000 outputs');
});

/* -------------------------------------------------------------------------- */
/* Random mode                                                                */
/* -------------------------------------------------------------------------- */

const ALL_TIERS = ['mild', 'medium', 'severe'];
const randomRequest = (sets: number, seed = 7): JobRequest => ({
  roots: ['D:\Dataset-01'],
  degradations: ['blur', 'noise', 'compression', 'motion_blur', 'brightness'],
  levels: {
    blur: ALL_TIERS,
    noise: ALL_TIERS,
    compression: ALL_TIERS,
    motion_blur: ALL_TIERS,
    brightness: ALL_TIERS,
  },
  options: { ...baseOptions, randomMode: true, randomSets: sets, randomSeed: seed },
});

const manyVideos = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const name = `video${String(i + 1).padStart(3, '0')}`;
    return video({
      path: `D:\Dataset-01\${name}.mp4`,
      relativePath: `${name}.mp4`,
      fileName: `${name}.mp4`,
      baseName: name,
    });
  });

test('random mode produces videos x sets outputs, one per set folder', () => {
  const plan = planTasks(randomRequest(3), [scan(manyVideos(100))]);

  assert.equal(plan.tasks.length, 300);
  assert.match(plan.formula, /100 videos x 3 random sets .* = 300 outputs/);
  for (const set of [1, 2, 3]) {
    assert.equal(plan.tasks.filter((t) => t.randomSet === set).length, 100);
  }
  const first = plan.tasks[0];
  assert.equal(first.randomSet, 1);
  assert.match(
    first.outputRelative,
    new RegExp(`^random/set_1/video001_${getDegradationSuffix(first.degradation)}_${first.level}\.mp4$`),
  );
});

test('random mode is deterministic per seed and varies across degradations and tiers', () => {
  const videos = manyVideos(200);
  const a = planTasks(randomRequest(2, 42), [scan(videos)]);
  const b = planTasks(randomRequest(2, 42), [scan(videos)]);
  const c = planTasks(randomRequest(2, 43), [scan(videos)]);

  const key = (p: typeof a) => p.tasks.map((t) => `${t.degradation}/${t.level}`).join(',');
  assert.equal(key(a), key(b));
  assert.notEqual(key(a), key(c));

  assert.equal(new Set(a.tasks.map((t) => t.degradation)).size, 5);
  assert.equal(new Set(a.tasks.map((t) => t.severity)).size, 3);

  // A video never gets the same degradation+level twice while unused pairs remain.
  for (let i = 0; i < a.tasks.length; i += 2) {
    const [x, y] = [a.tasks[i], a.tasks[i + 1]];
    assert.equal(x.sourcePath, y.sourcePath);
    assert.notEqual(`${x.degradation}/${x.level}`, `${y.degradation}/${y.level}`);
  }
});

function getDegradationSuffix(id: string): string {
  return { blur: 'blur', noise: 'noise', compression: 'compression', motion_blur: 'motionblur', brightness: 'brightness' }[id] ?? id;
}
