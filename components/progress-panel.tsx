'use client';

import {
  Activity,
  Ban,
  Download,
  Pause,
  Play,
  RefreshCcw,
  RotateCw,
} from 'lucide-react';
import type { JobSnapshot } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { asciiBar, formatBytes, formatMs, formatNumber } from '@/lib/format';

interface Props {
  snapshot: JobSnapshot;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  onExport: () => void;
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  running: 'default',
  paused: 'warning',
  completed: 'success',
  cancelled: 'muted',
  failed: 'destructive',
  idle: 'muted',
};

/** Live progress, per-worker detail and run controls (spec 21, 23, 24). */
export function ProgressPanel({
  snapshot,
  busy,
  onPause,
  onResume,
  onCancel,
  onRetryFailed,
  onExport,
}: Props) {
  const { counts } = snapshot;
  const finished = counts.completed + counts.failed + counts.skipped + counts.cancelled;
  const fraction = counts.total > 0 ? finished / counts.total : 0;
  const percent = Math.round(fraction * 100);
  const active = snapshot.status === 'running' || snapshot.status === 'paused';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Progress
            <Badge variant={STATUS_VARIANT[snapshot.status] ?? 'muted'} className="uppercase">
              {snapshot.status}
            </Badge>
          </CardTitle>
          <CardDescription className="font-mono text-xs">job {snapshot.id}</CardDescription>
        </div>

        <div className="flex flex-wrap gap-2">
          {snapshot.status === 'running' ? (
            <Button variant="outline" size="sm" onClick={onPause} disabled={busy}>
              <Pause />
              Pause
            </Button>
          ) : null}
          {snapshot.status === 'paused' ? (
            <Button size="sm" onClick={onResume} disabled={busy}>
              <Play />
              Resume
            </Button>
          ) : null}
          {active ? (
            <Button variant="destructive" size="sm" onClick={onCancel} disabled={busy}>
              <Ban />
              Cancel
            </Button>
          ) : null}
          {counts.failed > 0 && !active ? (
            <Button variant="outline" size="sm" onClick={onRetryFailed} disabled={busy}>
              <RotateCw />
              Retry failed ({counts.failed})
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" onClick={onExport} disabled={busy}>
            <Download />
            Export metadata
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm text-muted-foreground">
              {asciiBar(fraction)} {percent}%
            </span>
            <span className="tabular text-sm">
              {formatNumber(finished)} / {formatNumber(counts.total)}
            </span>
          </div>
          <Progress value={percent} className="h-3" />
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>Elapsed {formatMs(snapshot.elapsedMs)}</span>
            <span>
              ETA {snapshot.etaMs === null ? '-' : formatMs(snapshot.etaMs)}
            </span>
            <span>Written {formatBytes(snapshot.outputBytes)}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Count label="Completed" value={counts.completed} tone="success" />
          <Count label="Processing" value={counts.running} tone="primary" />
          <Count label="Remaining" value={counts.pending} />
          <Count label="Failed" value={counts.failed} tone={counts.failed > 0 ? 'error' : undefined} />
          <Count label="Skipped" value={counts.skipped} />
        </div>

        {snapshot.active.length > 0 ? (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Currently processing
              </p>
              {snapshot.active.map((task) => (
                <div key={task.taskId} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-path font-mono text-xs">{task.sourceRelative}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline">{task.degradation}</Badge>
                      <Badge variant="secondary">{task.level}</Badge>
                      {task.speed ? (
                        <span className="tabular text-xs text-muted-foreground">{task.speed}</span>
                      ) : null}
                    </div>
                  </div>
                  <Progress value={Math.round(task.progress * 100)} className="mt-2 h-1.5" />
                </div>
              ))}
            </div>
          </>
        ) : null}

        {snapshot.datasets.length > 1 ? (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Per dataset
              </p>
              {snapshot.datasets.map((dataset) => (
                <div key={dataset.root} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{dataset.name}</span>
                    <span className="tabular text-muted-foreground">
                      {formatNumber(dataset.done)} / {formatNumber(dataset.total)}
                    </span>
                  </div>
                  <Progress
                    value={dataset.total > 0 ? (dataset.done / dataset.total) * 100 : 0}
                    className="h-1.5"
                  />
                </div>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'error' | 'primary';
}) {
  const colour =
    tone === 'success'
      ? 'text-[var(--success)]'
      : tone === 'error'
        ? 'text-[var(--destructive)]'
        : tone === 'primary'
          ? 'text-primary'
          : '';
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`tabular text-xl font-semibold ${colour}`}>{formatNumber(value)}</p>
    </div>
  );
}
