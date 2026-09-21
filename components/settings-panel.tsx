'use client';

import { Cpu, FolderOutput, RotateCcw, Settings2 } from 'lucide-react';
import type { JobOptions } from '@/types';
import { WORKER_CHOICES, X264_PRESETS } from '@/lib/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

interface Props {
  options: JobOptions;
  cpuCount: number;
  disabled: boolean;
  /** Where output will actually go, resolved server-side for the first dataset. */
  resolvedOutputRoots: string[];
  onChange: (patch: Partial<JobOptions>) => void;
  onBrowseOutput: () => void;
}

/** Concurrency (spec 20) and run behaviour (spec 25, 30, 36). */
export function SettingsPanel({
  options,
  cpuCount,
  disabled,
  resolvedOutputRoots,
  onChange,
  onBrowseOutput,
}: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="size-4 text-muted-foreground" />
          Processing settings
        </CardTitle>
        <CardDescription>
          Concurrency is capped deliberately - more workers is not always faster, and an unbounded
          pool will bury the machine.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Output folder
            </Label>
            {options.outputRoot ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={disabled}
                onClick={() => onChange({ outputRoot: null })}
              >
                <RotateCcw />
                Use default
              </Button>
            ) : null}
          </div>

          <div className="mt-2 flex gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-md border border-input px-3 py-2">
              <span className="break-path font-mono text-xs text-muted-foreground">
                {options.outputRoot ?? 'Default - beside each dataset'}
              </span>
            </div>
            <Button variant="outline" disabled={disabled} onClick={onBrowseOutput}>
              <FolderOutput />
              Browse
            </Button>
          </div>

          <p className="mt-1.5 text-xs text-muted-foreground">
            {options.outputRoot
              ? 'Each dataset gets its own subfolder here, so several folders never mix.'
              : 'Output is written to degraded_output/ inside each input folder. Originals are never touched either way.'}
          </p>

          {resolvedOutputRoots.length > 0 ? (
            <div className="mt-2 space-y-0.5 rounded-md border border-border bg-muted/30 px-3 py-2">
              <p className="text-xs font-medium">Will write to:</p>
              {resolvedOutputRoots.slice(0, 4).map((root) => (
                <p key={root} className="break-path font-mono text-[11px] text-muted-foreground">
                  {root}
                </p>
              ))}
              {resolvedOutputRoots.length > 4 ? (
                <p className="text-[11px] text-muted-foreground">
                  ...and {resolvedOutputRoots.length - 4} more
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <Separator />

        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Workers (parallel ffmpeg processes)
          </Label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {WORKER_CHOICES.map((count) => (
              <Button
                key={count}
                type="button"
                variant={options.workers === count ? 'default' : 'outline'}
                size="sm"
                disabled={disabled}
                onClick={() => onChange({ workers: count })}
                className="w-11 tabular"
              >
                {count}
              </Button>
            ))}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cpu className="size-3.5" />
              {cpuCount} logical cores detected
            </span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="preset" className="text-xs uppercase tracking-wide text-muted-foreground">
              x264 preset
            </Label>
            <Select
              value={options.encoderPreset}
              disabled={disabled}
              onValueChange={(value) => onChange({ encoderPreset: value })}
            >
              <SelectTrigger id="preset" className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {X264_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {preset}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Speed against compression efficiency. veryfast is a good choice for large batches.
            </p>
          </div>

          <div>
            <Label htmlFor="basecrf" className="text-xs uppercase tracking-wide text-muted-foreground">
              Base CRF (non-compression degradations)
            </Label>
            <Select
              value={String(options.baseCrf)}
              disabled={disabled}
              onValueChange={(value) => onChange({ baseCrf: Number(value) })}
            >
              <SelectTrigger id="basecrf" className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[14, 16, 18, 20, 23].map((crf) => (
                  <SelectItem key={crf} value={String(crf)}>
                    CRF {crf}
                    {crf === 18 ? ' (recommended)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Kept visually lossless so a blur output is degraded by the blur, not by the encode.
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <Toggle
            id="skip-existing"
            label="Skip existing output"
            hint="A finished output file is left alone, so an interrupted run resumes where it stopped."
            checked={options.skipExisting}
            disabled={disabled || options.forceReprocess}
            onChange={(v) => onChange({ skipExisting: v })}
          />
          <Toggle
            id="force"
            label="Force reprocess"
            hint="Re-encode everything, overwriting output that already exists."
            checked={options.forceReprocess}
            disabled={disabled}
            onChange={(v) => onChange({ forceReprocess: v })}
          />
          <Toggle
            id="checksums"
            label="SHA-256 checksums"
            hint="Hash every source and output for lineage. Adds a full read of each file."
            checked={options.computeChecksums}
            disabled={disabled}
            onChange={(v) => onChange({ computeChecksums: v })}
          />
          <Toggle
            id="severity-name"
            label="Always include severity in filename"
            hint="Off: video001_blur.mp4 when one severity is selected. On: video001_blur_medium.mp4 always - safer when a dataset is built across several runs."
            checked={options.alwaysIncludeSeverityInName}
            disabled={disabled}
            onChange={(v) => onChange({ alwaysIncludeSeverityInName: v })}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
