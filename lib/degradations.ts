/**
 * The degradation catalogue.
 *
 * This module is imported by both the browser and the server, so it must stay
 * free of Node built-ins. It describes *what* each degradation is; the actual
 * ffmpeg argument construction lives in `processors/`.
 */

import type {
  DegradationDefinition,
  DegradationId,
  DegradationLevel,
  OutputKind,
  Severity,
} from '@/types';
import { COMBINED_ID, SEVERITIES } from '@/types';

const level = (
  id: string,
  label: string,
  tier: Severity | null,
  summary: string,
  params: Record<string, number | string>,
): DegradationLevel => ({ id, label, tier, summary, params });

/**
 * Blur.
 *
 * Implemented with `gblur` (gaussian) rather than `boxblur` because a gaussian
 * kernel is what the deepfake-robustness literature normally means by "blur".
 * The spec is written in terms of a pixel radius, so both numbers are recorded:
 * sigma = radius / 3, the usual approximation where a gaussian kernel is
 * considered to vanish beyond 3 sigma.
 */
const blur: DegradationDefinition = {
  id: 'blur',
  label: 'Blur',
  description: 'Gaussian blur. Softens fine texture and compression artefacts.',
  folder: 'blur',
  suffix: 'blur',
  levels: [
    level('mild', 'Mild', 'mild', 'radius 5 (sigma 1.67)', { radius: 5, sigma: 1.67 }),
    level('medium', 'Medium', 'medium', 'radius 10 (sigma 3.33)', { radius: 10, sigma: 3.33 }),
    level('severe', 'Severe', 'severe', 'radius 20 (sigma 6.67)', { radius: 20, sigma: 6.67 }),
  ],
};

/**
 * Noise. `noise=alls=<strength>:allf=t+u` - temporal + uniform additive noise.
 */
const noise: DegradationDefinition = {
  id: 'noise',
  label: 'Noise',
  description: 'Additive temporal noise, simulating a poor sensor or low light.',
  folder: 'noise',
  suffix: 'noise',
  levels: [
    level('mild', 'Mild', 'mild', 'strength 10', { strength: 10 }),
    level('medium', 'Medium', 'medium', 'strength 25', { strength: 25 }),
    level('severe', 'Severe', 'severe', 'strength 50', { strength: 50 }),
  ],
};

/** Compression. Straight CRF ladder on libx264. */
const compression: DegradationDefinition = {
  id: 'compression',
  label: 'Compression',
  description: 'Heavy H.264 re-encode. Blocking and ringing artefacts.',
  folder: 'compression',
  suffix: 'compression',
  levels: [
    level('mild', 'Mild', 'mild', 'CRF 28', { crf: 28 }),
    level('medium', 'Medium', 'medium', 'CRF 34', { crf: 34 }),
    level('severe', 'Severe', 'severe', 'CRF 40', { crf: 40 }),
  ],
};

/**
 * Low resolution.
 *
 * `height` is the target for the *shorter* side, which is what "480p" means for
 * both landscape and portrait footage. Aspect ratio is always preserved and the
 * video is never upscaled (see processors/resolution.ts).
 */
const lowResolution: DegradationDefinition = {
  id: 'low_resolution',
  label: 'Low Resolution',
  description: 'Downscale then re-encode. Aspect ratio preserved, never upscaled.',
  folder: 'low_resolution',
  suffix: 'lowres',
  levels: [
    level('720p', '720p', 'mild', 'short side 720px', { height: 720 }),
    level('480p', '480p', 'medium', 'short side 480px', { height: 480 }),
    level('360p', '360p', null, 'short side 360px', { height: 360 }),
    level('240p', '240p', 'severe', 'short side 240px', { height: 240 }),
  ],
};

/** FPS reduction. Never increases frame rate (see processors/fps.ts). */
const fpsReduction: DegradationDefinition = {
  id: 'fps_reduction',
  label: 'FPS Reduction',
  description: 'Resample to a lower frame rate. Sources already below target are left alone.',
  folder: 'fps_reduction',
  suffix: 'fps',
  levels: [
    level('30fps', '30 FPS', null, '30 fps', { fps: 30 }),
    level('24fps', '24 FPS', 'mild', '24 fps', { fps: 24 }),
    level('15fps', '15 FPS', 'medium', '15 fps', { fps: 15 }),
    level('10fps', '10 FPS', null, '10 fps', { fps: 10 }),
    level('5fps', '5 FPS', 'severe', '5 fps', { fps: 5 }),
  ],
};

/**
 * Frame drop.
 *
 * Duration is preserved: frames are discarded but timestamps are not rebased,
 * so the encoder holds the previous frame. That reproduces the stutter of a
 * lossy capture rather than simply making the clip shorter.
 */
const frameDrop: DegradationDefinition = {
  id: 'frame_drop',
  label: 'Frame Drop',
  description: 'Discard a fixed share of frames, keeping the original duration (stutter).',
  folder: 'frame_drop',
  suffix: 'framedrop',
  levels: [
    level('5pct', '5%', 'mild', 'drop 5% of frames', { percent: 5 }),
    level('10pct', '10%', 'medium', 'drop 10% of frames', { percent: 10 }),
    level('20pct', '20%', null, 'drop 20% of frames', { percent: 20 }),
    level('30pct', '30%', 'severe', 'drop 30% of frames', { percent: 30 }),
  ],
};

/** Motion blur via `tmix` - a rolling average over N frames. */
const motionBlur: DegradationDefinition = {
  id: 'motion_blur',
  label: 'Motion Blur',
  description: 'Temporal frame averaging, as produced by a long exposure.',
  folder: 'motion_blur',
  suffix: 'motionblur',
  levels: [
    level('mild', 'Mild', 'mild', 'average 3 frames', { frames: 3 }),
    level('medium', 'Medium', 'medium', 'average 5 frames', { frames: 5 }),
    level('severe', 'Severe', 'severe', 'average 9 frames', { frames: 9 }),
  ],
};

/** Brightness reduction. `eq=brightness` is additive in [-1, 1]. */
const brightness: DegradationDefinition = {
  id: 'brightness',
  label: 'Brightness Reduction',
  description: 'Darken the image, as in an underexposed or night-time capture.',
  folder: 'brightness',
  suffix: 'brightness',
  levels: [
    level('mild', 'Mild', 'mild', '-10% brightness', { brightness: -0.1, percent: -10 }),
    level('medium', 'Medium', 'medium', '-25% brightness', { brightness: -0.25, percent: -25 }),
    level('severe', 'Severe', 'severe', '-50% brightness', { brightness: -0.5, percent: -50 }),
  ],
};

/** Contrast reduction. `eq=contrast` is multiplicative, 1.0 = unchanged. */
const contrast: DegradationDefinition = {
  id: 'contrast',
  label: 'Contrast Reduction',
  description: 'Flatten the tonal range, as in a washed-out re-capture.',
  folder: 'contrast',
  suffix: 'contrast',
  levels: [
    level('mild', 'Mild', 'mild', 'contrast 0.85', { contrast: 0.85, percent: -15 }),
    level('medium', 'Medium', 'medium', 'contrast 0.65', { contrast: 0.65, percent: -35 }),
    level('severe', 'Severe', 'severe', 'contrast 0.45', { contrast: 0.45, percent: -55 }),
  ],
};

/** Saturation reduction. `eq=saturation`, 1.0 = unchanged, 0 = greyscale. */
const saturation: DegradationDefinition = {
  id: 'saturation',
  label: 'Saturation Reduction',
  description: 'Drain colour towards greyscale.',
  folder: 'saturation',
  suffix: 'saturation',
  levels: [
    level('mild', 'Mild', 'mild', 'saturation 0.75', { saturation: 0.75, percent: -25 }),
    level('medium', 'Medium', 'medium', 'saturation 0.50', { saturation: 0.5, percent: -50 }),
    level('severe', 'Severe', 'severe', 'saturation 0.20', { saturation: 0.2, percent: -80 }),
  ],
};

export const DEGRADATIONS: DegradationDefinition[] = [
  blur,
  noise,
  compression,
  lowResolution,
  fpsReduction,
  frameDrop,
  motionBlur,
  brightness,
  contrast,
  saturation,
];

/** The synthetic definition used for `combined/` outputs. */
export const COMBINED_DEFINITION: DegradationDefinition = {
  id: COMBINED_ID,
  label: 'Combined',
  description: 'Every selected degradation chained together in the configured order.',
  folder: 'combined',
  suffix: 'combined',
  levels: SEVERITIES.map((s) =>
    level(s, s[0].toUpperCase() + s.slice(1), s, `all selected degradations at ${s}`, {}),
  ),
};

const BY_ID = new Map<string, DegradationDefinition>(
  [...DEGRADATIONS, COMBINED_DEFINITION].map((d) => [d.id, d]),
);

export function getDegradation(id: OutputKind): DegradationDefinition {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown degradation: ${id}`);
  return def;
}

export function getLevel(id: OutputKind, levelId: string): DegradationLevel {
  const def = getDegradation(id);
  const found = def.levels.find((l) => l.id === levelId);
  if (!found) throw new Error(`Unknown level "${levelId}" for degradation "${id}"`);
  return found;
}

/** The level a degradation uses for a given severity tier, if it defines one. */
export function levelForTier(id: OutputKind, tier: Severity): DegradationLevel | null {
  return getDegradation(id).levels.find((l) => l.tier === tier) ?? null;
}

/** Default level ids for a degradation given the selected severity tiers. */
export function defaultLevelIds(id: OutputKind, tiers: Severity[]): string[] {
  const ids: string[] = [];
  for (const tier of tiers) {
    const l = levelForTier(id, tier);
    if (l) ids.push(l.id);
  }
  return ids;
}

export function isDegradationId(value: string): value is DegradationId {
  return DEGRADATIONS.some((d) => d.id === value);
}
