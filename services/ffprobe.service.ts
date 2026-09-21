/**
 * ffprobe wrapper: reads technical metadata without decoding the video.
 */

import { spawn } from 'node:child_process';
import { requireFfprobe } from './ffmpeg.service';

export interface ProbeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrateBps: number | null;
  pixelFormat: string | null;
  rotationDeg: number;
  error: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  pix_fmt?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; size?: string };
}

/** "30000/1001" -> 29.97, "25/1" -> 25, "0/0" -> null */
function parseRational(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  const fps = n / d;
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(6)) : null;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Rotation can arrive either as a legacy `rotate` tag or as a display-matrix
 * side-data entry. A 90/270 degree rotation means the *displayed* frame is
 * portrait even though the coded frame is landscape, which changes what "the
 * shorter side" means for the low-resolution processor.
 */
function readRotation(stream: FfprobeStream): number {
  const tag = stream.tags?.rotate;
  if (tag !== undefined) {
    const n = Number(tag);
    if (Number.isFinite(n)) return ((Math.round(n) % 360) + 360) % 360;
  }
  for (const side of stream.side_data_list ?? []) {
    const value = side.rotation;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return ((Math.round(value) % 360) + 360) % 360;
    }
  }
  return 0;
}

function runProbe(bin: string, filePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`ffprobe timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `ffprobe exited with code ${code}`));
    });
  });
}

/**
 * Probe one file. Never throws for a bad video: a corrupt or unsupported file
 * comes back with `error` set so the batch can mark it and carry on.
 */
export async function probeVideo(filePath: string, timeoutMs = 30_000): Promise<ProbeResult> {
  const empty: ProbeResult = {
    durationSec: null,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    bitrateBps: null,
    pixelFormat: null,
    rotationDeg: 0,
    error: null,
  };

  let bin: string;
  try {
    bin = await requireFfprobe();
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }

  let raw: string;
  try {
    raw = await runProbe(bin, filePath, timeoutMs);
  } catch (error) {
    return { ...empty, error: (error as Error).message };
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(raw) as FfprobeOutput;
  } catch {
    return { ...empty, error: 'ffprobe returned output that could not be parsed as JSON.' };
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) {
    return {
      ...empty,
      audioCodec: audio?.codec_name ?? null,
      error: 'No video stream found in this file.',
    };
  }

  const rotation = readRotation(video);
  const swap = rotation === 90 || rotation === 270;
  const codedWidth = video.width ?? null;
  const codedHeight = video.height ?? null;

  const duration = parseNumber(parsed.format?.duration) ?? parseNumber(video.duration);
  // avg_frame_rate reflects the whole file; r_frame_rate is the container's
  // nominal rate and is wrong for variable-frame-rate sources.
  const fps = parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate);

  return {
    durationSec: duration,
    width: swap ? codedHeight : codedWidth,
    height: swap ? codedWidth : codedHeight,
    fps,
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrateBps: parseNumber(parsed.format?.bit_rate) ?? parseNumber(video.bit_rate),
    pixelFormat: video.pix_fmt ?? null,
    rotationDeg: rotation,
    error: duration === null && codedWidth === null ? 'File could not be decoded.' : null,
  };
}
