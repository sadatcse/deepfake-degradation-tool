/**
 * Path handling and the security boundary for the whole application.
 *
 * Every filesystem operation triggered by an HTTP request funnels through
 * `assertAllowed` / `assertInside`. That is what keeps a crafted request from
 * reading or writing outside the folders the user actually chose.
 */

import path from 'node:path';
import os from 'node:os';

/** Name of the generated output folder created inside each dataset root. */
export const OUTPUT_DIR_NAME = 'degraded_output';

/** Scratch folder for preview clips, nested inside OUTPUT_DIR_NAME. */
export const PREVIEW_DIR_NAME = '.previews';

/** Extension used while a file is still being written. */
export const PARTIAL_SUFFIX = '.part';

/** Windows path comparison is case-insensitive; POSIX is not. */
const CASE_INSENSITIVE = process.platform === 'win32';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Resolve to an absolute, normalised path without following symlinks. */
export function normalize(input: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('A path is required.');
  }
  // Reject NUL bytes outright - they truncate paths in some syscalls.
  if (input.includes('\0')) {
    throw new Error('Path contains an illegal NUL byte.');
  }
  let p = input.trim();
  // Expand a leading ~ so users can type ~/datasets.
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function comparable(p: string): string {
  const n = path.resolve(p);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = comparable(parent);
  const c = comparable(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Throw unless `child` is contained by `parent`. */
export function assertInside(parent: string, child: string, what = 'path'): void {
  if (!isInside(parent, child)) {
    throw new Error(
      `Refusing to touch ${what} outside the selected folder.\n  folder: ${parent}\n  ${what}: ${child}`,
    );
  }
}

/**
 * Optional allow-list from ALLOWED_ROOTS. When unset the tool can reach any
 * folder the OS user already has access to, which is the expected behaviour for
 * a local desktop tool. Setting it is useful when the app is left running.
 */
export function getAllowedRoots(): string[] | null {
  const raw = process.env.ALLOWED_ROOTS?.trim();
  if (!raw) return null;
  const roots = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
  return roots.length > 0 ? roots : null;
}

/** Throw when ALLOWED_ROOTS is configured and `target` falls outside all of them. */
export function assertAllowed(target: string): string {
  const abs = normalize(target);
  const roots = getAllowedRoots();
  if (roots && !roots.some((r) => isInside(r, abs))) {
    throw new Error(
      `Path is outside ALLOWED_ROOTS.\n  path: ${abs}\n  allowed: ${roots.join(', ')}`,
    );
  }
  return abs;
}

/** The default degraded_output folder, nested inside the dataset root. */
export function outputRoot(datasetRoot: string): string {
  return path.join(normalize(datasetRoot), OUTPUT_DIR_NAME);
}

/**
 * Where a dataset's output actually goes.
 *
 * With no custom root this is `<dataset>/degraded_output`, exactly as before.
 * With one, the output is nested one level under it by dataset name:
 *
 *   E:\renders  +  D:\Dataset-01   ->   E:\renders\Dataset-01\blur\...
 *
 * The nesting is unconditional rather than "only when several folders are
 * selected", because each dataset owns its own metadata.json/manifest.json.
 * A layout that changed shape when a second folder was added would silently
 * break resume for the first one.
 */
export function resolveOutputRoot(datasetRoot: string, customRoot?: string | null): string {
  const dataset = normalize(datasetRoot);
  if (!customRoot || customRoot.trim() === '') return outputRoot(dataset);
  return path.join(normalize(customRoot), sanitizeSegment(datasetName(dataset)));
}

export interface OutputRootProblem {
  code: 'inside-input' | 'contains-input' | 'same-as-input' | 'name-collision';
  message: string;
}

/**
 * Reject output locations that would corrupt a later run.
 *
 * The important one is `inside-input`: the scanner only skips a folder called
 * `degraded_output`, so an output folder anywhere else under a dataset would be
 * picked up as *input* on the next scan - quietly feeding degraded videos back
 * through the pipeline and compounding the degradation.
 */
export function validateOutputRoot(
  customRoot: string | null | undefined,
  inputRoots: readonly string[],
): OutputRootProblem | null {
  if (!customRoot || customRoot.trim() === '') return null;

  const out = normalize(customRoot);

  for (const raw of inputRoots) {
    const input = normalize(raw);

    if (comparable(out) === comparable(input)) {
      return {
        code: 'same-as-input',
        message:
          `The output folder is the input folder (${input}). Leave it blank to use ` +
          `the default ${OUTPUT_DIR_NAME}/ inside the dataset, or choose a folder elsewhere.`,
      };
    }

    if (isInside(input, out)) {
      return {
        code: 'inside-input',
        message:
          `The output folder sits inside the input folder ${input}. A later scan would ` +
          `pick those generated videos up as new input. Leave it blank to use the default ` +
          `${OUTPUT_DIR_NAME}/ (which the scanner always ignores), or choose a folder outside the dataset.`,
      };
    }

    if (isInside(out, input)) {
      return {
        code: 'contains-input',
        message:
          `The output folder ${out} contains the input folder ${input}. ` +
          `Choose an output folder that does not enclose a dataset.`,
      };
    }
  }

  // Two datasets whose folder names match would resolve to the same output
  // subfolder and write over each other's metadata.
  const seen = new Map<string, string>();
  for (const raw of inputRoots) {
    const input = normalize(raw);
    const name = comparable(sanitizeSegment(datasetName(input)));
    const previous = seen.get(name);
    if (previous) {
      return {
        code: 'name-collision',
        message:
          `Two selected folders are both named "${datasetName(input)}" (${previous} and ${input}), ` +
          `so they would share one output folder under ${out}. Rename one, process them ` +
          `separately, or leave the output folder blank to keep each dataset's output beside it.`,
      };
    }
    seen.set(name, input);
  }

  return null;
}

/** A readable name for a dataset root, e.g. `Dataset-01`. */
export function datasetName(root: string): string {
  const abs = normalize(root);
  const base = path.basename(abs);
  // path.basename('D:\\') is '' - fall back to the drive letter.
  return base || abs.replace(/[\\/:]/g, '') || abs;
}

/**
 * True when a directory should never be descended into while scanning.
 * Skipping `degraded_output` is what stops a second run from treating its own
 * output as new input.
 */
export function isIgnoredDir(name: string): boolean {
  if (name === OUTPUT_DIR_NAME) return true;
  if (name.startsWith('.')) return true;
  if (name === 'node_modules' || name === '$RECYCLE.BIN' || name === 'System Volume Information') {
    return true;
  }
  return false;
}

/** Strip characters that are illegal in a filename on any supported platform. */
export function sanitizeSegment(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
}
