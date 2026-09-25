/**
 * Request validation. Every API route parses its body through one of these, so
 * a malformed or hostile request is rejected before it reaches the filesystem.
 */

import { z } from 'zod';
import { DEGRADATION_IDS, SEVERITIES } from '@/types';

export const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;

export const WORKER_CHOICES = [1, 2, 4, 6, 8] as const;

/** A non-empty path string. Containment is enforced separately in utils/paths. */
export const pathSchema = z
  .string()
  .trim()
  .min(1, 'A folder path is required.')
  .max(4096)
  .refine((v) => !v.includes('\0'), 'Path contains an illegal NUL byte.');

export const degradationIdSchema = z.enum(DEGRADATION_IDS);
export const severitySchema = z.enum(SEVERITIES);

export const jobOptionsSchema = z.object({
  workers: z.number().int().min(1).max(16).default(2),
  skipExisting: z.boolean().default(true),
  forceReprocess: z.boolean().default(false),
  computeChecksums: z.boolean().default(true),
  alwaysIncludeSeverityInName: z.boolean().default(false),
  baseCrf: z.number().int().min(0).max(51).default(18),
  encoderPreset: z.enum(X264_PRESETS).default('medium'),
  combinedOrder: z.array(degradationIdSchema).default([]),
  includeCombined: z.boolean().default(false),
  // Blank/absent means the default <dataset>/degraded_output.
  outputRoot: pathSchema.nullable().optional().default(null),
  thermalProtection: z.boolean().default(true),
  tempThreshold: z.number().int().min(50).max(105).default(80),
  cooldownMinutes: z.number().int().min(1).max(120).default(30),
  randomMode: z.boolean().default(false),
  randomSets: z.number().int().min(1).max(20).default(2),
  randomSeed: z.number().int().min(0).max(2_147_483_647).default(1),
});

export const jobRequestSchema = z.object({
  roots: z.array(pathSchema).min(1, 'Select at least one input folder.').max(50),
  degradations: z.array(degradationIdSchema).min(1, 'Select at least one degradation.'),
  levels: z.record(z.string(), z.array(z.string().min(1).max(32))),
  options: jobOptionsSchema,
});

export const scanRequestSchema = z.object({
  root: pathSchema,
  force: z.boolean().optional().default(false),
  token: z.string().max(64).optional(),
});

export const estimateRequestSchema = jobRequestSchema;

export const previewRequestSchema = z.object({
  root: pathSchema,
  video: z.string().min(1).max(4096),
  selections: z
    .array(
      z.object({
        degradation: degradationIdSchema,
        level: z.string().min(1).max(32),
      }),
    )
    .max(24),
  combined: z
    .object({
      tier: severitySchema,
      steps: z.array(
        z.object({ degradation: degradationIdSchema, level: z.string().min(1).max(32) }),
      ),
    })
    .optional(),
  seconds: z.number().int().min(1).max(15).default(4),
  options: z.object({
    baseCrf: z.number().int().min(0).max(51).default(18),
    encoderPreset: z.enum(X264_PRESETS).default('veryfast'),
    outputRoot: pathSchema.nullable().optional().default(null),
  }),
});

export const controlSchema = z.object({
  action: z.enum([
    'pause',
    'resume',
    'cancel',
    'retry-failed',
    'force-reprocess',
    'export',
    'skip-thermal-rest',
  ]),
});

export const listRequestSchema = z.object({
  path: z.string().max(4096).optional(),
});

/**
 * The folder-path field in the picker. Validated client-side with React Hook
 * Form so a typo is caught before a request is made, and validated again on the
 * server by `pathSchema` plus the containment rules in utils/paths.
 */
export const folderPathFormSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1, 'Enter a folder path.')
    .max(4096, 'That path is too long.')
    .refine((v) => !v.includes('\0'), 'Path contains an illegal NUL byte.')
    .refine(
      (v) => /^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(v),
      'Enter an absolute path, for example D:\\Deepfake\\Dataset-01 or /data/videos.',
    ),
});

export type FolderPathForm = z.infer<typeof folderPathFormSchema>;

export type JobOptionsInput = z.input<typeof jobOptionsSchema>;
export type JobRequestInput = z.infer<typeof jobRequestSchema>;
export type PreviewRequestInput = z.infer<typeof previewRequestSchema>;
