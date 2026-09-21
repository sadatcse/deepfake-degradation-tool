/**
 * Everything that actually talks to ffmpeg.
 *
 * Videos are never read into memory: ffmpeg is spawned with `child_process.spawn`
 * and streams straight from the source file to the output file. The only data
 * this process reads back is ffmpeg's own progress report on stdout.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { BinaryInfo, SystemInfo } from '@/types';
import { getAllowedRoots } from '@/utils/paths';

/* -------------------------------------------------------------------------- */
/* Binary detection                                                           */
/* -------------------------------------------------------------------------- */

function runVersion(bin: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-version'], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error) });
      return;
    }

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out, err: 'Timed out after 10s.' });
    }, 10_000);

    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err });
    });
  });
}

/**
 * Parse the first line of `ffmpeg -version`. Covers release builds
 * ("ffmpeg version 7.1"), git builds ("ffmpeg version n6.0-12-gabc") and the
 * dated snapshots shipped by gyan.dev ("ffmpeg version 2025-01-01-git-...").
 */
function parseVersion(text: string): { version: string | null; major: number | null; minor: number | null } {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const match = firstLine.match(/version\s+(\S+)/i);
  const version = match ? match[1] : null;
  const semver = firstLine.match(/version\s+n?(\d+)\.(\d+)/i);
  return {
    version,
    major: semver ? Number(semver[1]) : null,
    minor: semver ? Number(semver[2]) : null,
  };
}

async function detect(envVar: string, fallback: string): Promise<BinaryInfo> {
  const configured = process.env[envVar]?.trim();
  const bin = configured && configured.length > 0 ? configured : fallback;
  const { ok, out, err } = await runVersion(bin);

  if (!ok) {
    return {
      available: false,
      path: null,
      version: null,
      major: null,
      minor: null,
      error:
        err.trim() ||
        `Could not execute "${bin}". It is not installed, or not on this account's PATH.`,
    };
  }

  const { version, major, minor } = parseVersion(out || err);
  return { available: true, path: bin, version, major, minor, error: null };
}

let cached: SystemInfo | null = null;

const SETUP_INSTRUCTIONS = [
  'Windows  -  winget install Gyan.FFmpeg   (or download from https://www.gyan.dev/ffmpeg/builds/ and add the bin folder to PATH)',
  'macOS    -  brew install ffmpeg',
  'Debian   -  sudo apt install ffmpeg',
  'Fedora   -  sudo dnf install ffmpeg',
  'Arch     -  sudo pacman -S ffmpeg',
  'Then restart this application, or set FFMPEG_PATH and FFPROBE_PATH in .env to absolute paths.',
];

export async function getSystemInfo(force = false): Promise<SystemInfo> {
  if (cached && !force) return cached;

  const [ffmpeg, ffprobe] = await Promise.all([
    detect('FFMPEG_PATH', 'ffmpeg'),
    detect('FFPROBE_PATH', 'ffprobe'),
  ]);

  cached = {
    ffmpeg,
    ffprobe,
    platform: process.platform,
    cpuCount: os.cpus().length || 1,
    totalMemoryBytes: os.totalmem(),
    allowedRoots: getAllowedRoots(),
    instructions: SETUP_INSTRUCTIONS,
  };
  return cached;
}

export async function requireFfmpeg(): Promise<string> {
  const info = await getSystemInfo();
  if (!info.ffmpeg.available || !info.ffmpeg.path) {
    throw new Error(
      'FFmpeg is not installed or not available in PATH.\n\n' + info.instructions.join('\n'),
    );
  }
  return info.ffmpeg.path;
}

export async function requireFfprobe(): Promise<string> {
  const info = await getSystemInfo();
  if (!info.ffprobe.available || !info.ffprobe.path) {
    throw new Error(
      'FFprobe is not installed or not available in PATH.\n\n' + info.instructions.join('\n'),
    );
  }
  return info.ffprobe.path;
}

/**
 * `-fps_mode` replaced `-vsync` in ffmpeg 5.1. Pick whichever the installed
 * build understands so frame-drop output keeps its original duration on both.
 */
export async function cfrArgs(): Promise<string[]> {
  const { ffmpeg } = await getSystemInfo();
  const major = ffmpeg.major ?? 0;
  const minor = ffmpeg.minor ?? 0;
  const modern = major > 5 || (major === 5 && minor >= 1);
  return modern ? ['-fps_mode', 'cfr'] : ['-vsync', 'cfr'];
}

/* -------------------------------------------------------------------------- */
/* Encode argument construction                                               */
/* -------------------------------------------------------------------------- */

export interface EncodeSpec {
  inputPath: string;
  outputPath: string;
  filters: string[];
  extraArgs: string[];
  crf: number;
  preset: string;
  forceCfr: boolean;
  outputFps?: number;
  /** Source audio codec from ffprobe; null means the source has no audio. */
  audioCodec: string | null;
  /** Preview clips only: seek offset and duration in seconds. */
  clip?: { start: number; duration: number };
}

/** Audio codecs that can be copied into an MP4 container untouched. */
const MP4_SAFE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

export async function buildEncodeArgs(spec: EncodeSpec): Promise<string[]> {
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
  ];

  // Fast seek goes before -i; duration after, so it counts from the seek point.
  if (spec.clip) args.push('-ss', String(spec.clip.start));
  args.push('-i', spec.inputPath);
  if (spec.clip) args.push('-t', String(spec.clip.duration));

  if (spec.filters.length > 0) {
    args.push('-vf', spec.filters.join(','));
  }

  args.push(
    '-c:v',
    'libx264',
    '-crf',
    String(spec.crf),
    '-preset',
    spec.preset,
    '-pix_fmt',
    'yuv420p',
  );

  if (spec.forceCfr) {
    args.push(...(await cfrArgs()));
    if (spec.outputFps && Number.isFinite(spec.outputFps)) {
      args.push('-r', String(spec.outputFps));
    }
  }

  // Previews are visual only - dropping audio keeps them small and fast.
  if (spec.clip) {
    args.push('-an');
  } else if (spec.audioCodec === null) {
    args.push('-an');
  } else if (MP4_SAFE_AUDIO.has(spec.audioCodec.toLowerCase())) {
    // Stream-copy when the container will accept the codec as-is.
    args.push('-c:a', 'copy');
  } else {
    // Vorbis/Opus/PCM and friends need re-encoding to land in an MP4.
    args.push('-c:a', 'aac', '-b:a', '128k');
  }

  args.push(...spec.extraArgs);
  args.push(spec.outputPath);
  return args;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

export interface FfmpegProgress {
  /** Seconds of output written so far. */
  outTimeSec: number;
  frame: number | null;
  fps: number | null;
  speed: string | null;
}

export interface RunOptions {
  onProgress?: (p: FfmpegProgress) => void;
  signal?: AbortSignal;
  /** Stderr lines retained for the error message. */
  stderrLines?: number;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/** `00:00:04.120000` -> 4.12 */
function parseTimecode(value: string): number | null {
  const m = value.trim().match(/^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]));
}

/**
 * Spawn ffmpeg and stream its progress.
 *
 * Resolves when ffmpeg exits 0. Rejects with an FfmpegError carrying the tail
 * of stderr otherwise, which is what the UI shows against a failed video.
 */
export function runFfmpeg(bin: string, args: string[], options: RunOptions = {}): Promise<void> {
  const keep = options.stderrLines ?? 20;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new FfmpegError('Cancelled before start.', null, ''));
      return;
    }

    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrTail: string[] = [];
    let stdoutBuffer = '';
    let settled = false;
    let aborted = false;

    const progress: FfmpegProgress = { outTimeSec: 0, frame: null, fps: null, speed: null };

    const onAbort = () => {
      aborted = true;
      // SIGKILL maps to TerminateProcess on Windows; ffmpeg has no cleanup to do
      // because output goes to a .part file that the caller removes.
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      let dirty = false;
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();

        switch (key) {
          case 'out_time': {
            const seconds = parseTimecode(value);
            if (seconds !== null && seconds >= 0) {
              progress.outTimeSec = seconds;
              dirty = true;
            }
            break;
          }
          case 'out_time_us': {
            // Fallback for builds that omit out_time; ignore the "N/A" placeholder.
            const us = Number(value);
            if (Number.isFinite(us) && us >= 0 && progress.outTimeSec === 0) {
              progress.outTimeSec = us / 1_000_000;
              dirty = true;
            }
            break;
          }
          case 'frame': {
            const n = Number(value);
            if (Number.isFinite(n)) progress.frame = n;
            break;
          }
          case 'fps': {
            const n = Number(value);
            if (Number.isFinite(n)) progress.fps = n;
            break;
          }
          case 'speed': {
            progress.speed = value === 'N/A' ? null : value;
            break;
          }
          default:
            break;
        }
      }
      if (dirty) options.onProgress?.({ ...progress });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) stderrTail.push(line.trim());
      }
      if (stderrTail.length > keep) stderrTail = stderrTail.slice(-keep);
    });

    child.on('error', (error) => {
      finish(() => reject(new FfmpegError(error.message, null, stderrTail.join('\n'))));
    });

    child.on('close', (code) => {
      const stderr = stderrTail.join('\n');
      if (aborted) {
        finish(() => reject(new FfmpegError('Cancelled.', code, stderr)));
      } else if (code === 0) {
        finish(resolve);
      } else {
        const detail = stderr || `ffmpeg exited with code ${code}`;
        finish(() => reject(new FfmpegError(detail, code, stderr)));
      }
    });
  });
}
