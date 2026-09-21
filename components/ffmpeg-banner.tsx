'use client';

import { useState } from 'react';
import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SystemInfo } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  system: SystemInfo | null;
  onRecheck: () => Promise<void>;
}

/**
 * FFmpeg / FFprobe availability (spec 45).
 *
 * When either binary is missing the banner carries the exact install command
 * for each platform, and a Re-check button so the user can install ffmpeg and
 * carry on without restarting the app.
 */
export function FfmpegBanner({ system, onRecheck }: Props) {
  const [checking, setChecking] = useState(false);

  if (!system) return null;

  const ready = system.ffmpeg.available && system.ffprobe.available;

  const recheck = async () => {
    setChecking(true);
    try {
      await onRecheck();
    } finally {
      setChecking(false);
    }
  };

  if (ready) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="size-4 text-[var(--success)]" />
        <span className="font-medium text-foreground">FFmpeg ready</span>
        <Badge variant="muted" className="font-mono">
          ffmpeg {system.ffmpeg.version ?? 'unknown'}
        </Badge>
        <Badge variant="muted" className="font-mono">
          ffprobe {system.ffprobe.version ?? 'unknown'}
        </Badge>
        <span className="text-muted-foreground">
          {system.platform} &middot; {system.cpuCount} CPU cores
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={recheck}
          disabled={checking}
          className="h-6 px-2 text-xs"
        >
          <RefreshCw className={checking ? 'animate-spin' : ''} />
          Re-check
        </Button>
      </div>
    );
  }

  const missingList = [
    !system.ffmpeg.available ? 'FFmpeg' : null,
    !system.ffprobe.available ? 'FFprobe' : null,
  ].filter((name): name is string => name !== null);

  const missing = missingList.join(' and ');
  const verb = missingList.length > 1 ? 'are' : 'is';

  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{`${missing} ${verb} not installed or not available in PATH.`}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p className="text-muted-foreground">
          Nothing can be scanned or encoded until this is fixed. Install it with one of the
          following, then re-check:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-[var(--background)] p-3 font-mono text-xs leading-relaxed text-foreground">
          {system.instructions.join('\n')}
        </pre>
        {system.ffmpeg.error ? (
          <p className="break-path font-mono text-xs text-muted-foreground">
            ffmpeg: {system.ffmpeg.error}
          </p>
        ) : null}
        {system.ffprobe.error ? (
          <p className="break-path font-mono text-xs text-muted-foreground">
            ffprobe: {system.ffprobe.error}
          </p>
        ) : null}
        <Button variant="outline" size="sm" onClick={recheck} disabled={checking}>
          <RefreshCw className={checking ? 'animate-spin' : ''} />
          {checking ? 'Checking...' : 'Re-check'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
