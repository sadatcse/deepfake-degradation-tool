'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { DatasetEntry } from '@/components/app-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DistributionChart } from '@/components/distribution-chart';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';

interface Props {
  datasets: DatasetEntry[];
  scanning: { root: string; phase: string; found: number; probed: number } | null;
  disabled: boolean;
  onAdd: () => void;
  onRemove: (root: string) => void;
  onRescan: (root: string) => void;
}

/** Input folders, their scan summary, and per-video metadata (spec 26, 34). */
export function DatasetPanel({
  datasets,
  scanning,
  disabled,
  onAdd,
  onRemove,
  onRescan,
}: Props) {
  const [active, setActive] = useState(0);

  const totals = datasets.reduce(
    (acc, d) => ({
      videos: acc.videos + d.videoCount,
      bytes: acc.bytes + d.summary.totalSizeBytes,
      duration: acc.duration + d.summary.totalDurationSec,
      unreadable: acc.unreadable + d.summary.unreadable,
    }),
    { videos: 0, bytes: 0, duration: 0, unreadable: 0 },
  );

  const current = datasets[Math.min(active, datasets.length - 1)];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="size-4 text-muted-foreground" />
            Input folders
          </CardTitle>
          <CardDescription>
            Each folder is processed independently and gets its own degraded_output/.
          </CardDescription>
        </div>
        <Button onClick={onAdd} disabled={disabled}>
          <Plus />
          {datasets.length === 0 ? 'Select folder' : 'Add folder'}
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {scanning ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            <div className="min-w-0">
              <p className="font-medium">
                {scanning.phase === 'walking' ? 'Finding videos' : 'Reading metadata'}
              </p>
              <p className="break-path font-mono text-xs text-muted-foreground">
                {scanning.phase === 'walking'
                  ? `${scanning.found} found`
                  : `${scanning.probed} / ${scanning.found} probed`}
                {' - '}
                {scanning.root}
              </p>
            </div>
          </div>
        ) : null}

        {datasets.length === 0 && !scanning ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <FolderOpen className="mx-auto size-8 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No folder selected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a folder of videos to scan. Supported: .mp4 .mov .avi .mkv .webm
            </p>
          </div>
        ) : null}

        {datasets.length > 0 ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Videos found" value={formatNumber(totals.videos)} />
              <Stat label="Total size" value={formatBytes(totals.bytes)} />
              <Stat label="Total duration" value={formatDuration(totals.duration)} />
              <Stat
                label="Unreadable"
                value={formatNumber(totals.unreadable)}
                tone={totals.unreadable > 0 ? 'warn' : undefined}
              />
            </div>

            <div className="space-y-2">
              {datasets.map((dataset, index) => (
                <div
                  key={dataset.root}
                  className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 ${
                    index === active ? 'border-primary/60 bg-accent/40' : 'border-border'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActive(index)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {dataset.name}
                      {dataset.hasExistingOutput ? (
                        <Badge variant="warning">has existing output</Badge>
                      ) : null}
                    </p>
                    <p className="break-path font-mono text-xs text-muted-foreground">
                      {dataset.root}
                    </p>
                  </button>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="tabular">{formatNumber(dataset.videoCount)} videos</span>
                    <span className="tabular">{formatBytes(dataset.summary.totalSizeBytes)}</span>
                    {dataset.disk.ok ? (
                      <span className="flex items-center gap-1 tabular">
                        <HardDrive className="size-3.5" />
                        {formatBytes(dataset.disk.freeBytes)} free
                      </span>
                    ) : null}
                  </div>

                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onRescan(dataset.root)}
                      disabled={disabled}
                      aria-label="Rescan folder"
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onRemove(dataset.root)}
                      disabled={disabled}
                      aria-label="Remove folder"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {current ? (
              <>
                <Separator />
                <Tabs defaultValue="breakdown">
                  <TabsList>
                    <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                  </TabsList>

                  <TabsContent value="breakdown">
                    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                      <DistributionChart title="Resolution" data={current.summary.resolutions} />
                      <DistributionChart title="Frame rate" data={current.summary.fpsBuckets} />
                      <DistributionChart title="Codec" data={current.summary.codecs} />
                      <DistributionChart title="Container" data={current.summary.extensions} />
                    </div>
                    {current.summary.splits.some((s) => s.label !== 'none') ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Dataset splits detected
                        </span>
                        {current.summary.splits
                          .filter((s) => s.label !== 'none')
                          .map((split) => (
                            <Badge key={split.label} variant="secondary">
                              {split.label}: {formatNumber(split.count)}
                            </Badge>
                          ))}
                        <span className="text-xs text-muted-foreground">
                          preserved in the output, never mixed
                        </span>
                      </div>
                    ) : null}
                  </TabsContent>

                  <TabsContent value="files">
                    <div className="max-h-96 overflow-y-auto rounded-lg border border-border">
                      <Table>
                        <TableHeader className="sticky top-0 bg-card">
                          <TableRow>
                            <TableHead>File</TableHead>
                            <TableHead>Duration</TableHead>
                            <TableHead>Resolution</TableHead>
                            <TableHead>FPS</TableHead>
                            <TableHead>Codec</TableHead>
                            <TableHead>Bitrate</TableHead>
                            <TableHead>Size</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {current.videos.map((video) => (
                            <TableRow key={video.path}>
                              <TableCell className="max-w-72">
                                <span className="break-path font-mono text-xs">
                                  {video.relativePath}
                                </span>
                                {video.probeError ? (
                                  <span className="mt-1 flex items-center gap-1 text-xs text-[var(--destructive)]">
                                    <AlertTriangle className="size-3" />
                                    {video.probeError}
                                  </span>
                                ) : null}
                              </TableCell>
                              <TableCell className="tabular text-xs">
                                {formatDuration(video.durationSec)}
                              </TableCell>
                              <TableCell className="tabular text-xs">
                                {video.width && video.height
                                  ? `${video.width}x${video.height}`
                                  : '-'}
                              </TableCell>
                              <TableCell className="tabular text-xs">
                                {video.fps ? video.fps.toFixed(2) : '-'}
                              </TableCell>
                              <TableCell className="text-xs">{video.videoCodec ?? '-'}</TableCell>
                              <TableCell className="tabular text-xs">
                                {video.bitrateBps
                                  ? `${Math.round(video.bitrateBps / 1000)} kbps`
                                  : '-'}
                              </TableCell>
                              <TableCell className="tabular text-xs">
                                {formatBytes(video.sizeBytes)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {current.truncated ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Showing the first {current.videos.length} of{' '}
                        {formatNumber(current.videoCount)} files. Every file is still processed -
                        the full list is written to metadata.csv.
                      </p>
                    ) : null}
                  </TabsContent>
                </Tabs>
              </>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn';
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={`tabular text-lg font-semibold ${
          tone === 'warn' ? 'text-[var(--warning)]' : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}
