'use client';

import { Calculator, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import type { EstimateResponse } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatNumber } from '@/lib/format';

interface Props {
  estimate: EstimateResponse | null;
  loading: boolean;
  error: string | null;
}

const STATUS_VARIANT = {
  READY: 'success',
  TIGHT: 'warning',
  INSUFFICIENT: 'destructive',
  UNKNOWN: 'muted',
} as const;

/** Output count and disk forecast shown before anything starts (spec 18, 37, 38). */
export function EstimatePanel({ estimate, loading, error }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calculator className="size-4 text-muted-foreground" />
          Estimate
        </CardTitle>
        <CardDescription>
          Counted from the same plan the engine will run, so this is the exact number of files that
          will be produced.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Could not build an estimate</AlertTitle>
            <AlertDescription className="break-path">{error}</AlertDescription>
          </Alert>
        ) : null}

        {loading && !estimate ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Calculating...
          </div>
        ) : null}

        {!loading && !estimate && !error ? (
          <p className="py-6 text-sm text-muted-foreground">
            Select a folder, at least one degradation and one severity to see the estimate.
          </p>
        ) : null}

        {estimate ? (
          <>
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="font-mono text-sm">{estimate.estimate.formula}</p>
              {estimate.skippedTasks > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {formatNumber(estimate.skippedTasks)} of those are already known to be skippable:{' '}
                  {estimate.skippedReasons.slice(0, 2).join('; ')}
                  {estimate.skippedReasons.length > 2 ? '; ...' : ''}
                </p>
              ) : null}
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Outputs to create" value={formatNumber(estimate.estimate.totalOutputs)} />
              <Stat label="Input size" value={formatBytes(estimate.estimate.inputBytes)} />
              <Stat
                label="Estimated output"
                value={formatBytes(estimate.estimate.estimatedOutputBytes)}
              />
              <div className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Disk status</p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[estimate.diskStatus]}>{estimate.diskStatus}</Badge>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatBytes(estimate.freeBytes)} free
                  </span>
                </div>
              </div>
            </div>

            {estimate.diskStatus === 'INSUFFICIENT' ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Not enough free space</AlertTitle>
                <AlertDescription>
                  The run is estimated at {formatBytes(estimate.estimate.estimatedOutputBytes)} but
                  only {formatBytes(estimate.freeBytes)} is available. Free some space, reduce the
                  selection, or point the dataset at another drive.
                </AlertDescription>
              </Alert>
            ) : null}

            {estimate.diskStatus === 'TIGHT' ? (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertTitle>Space will be tight</AlertTitle>
                <AlertDescription>
                  The estimate uses most of the free space on the target volume. Size estimates are
                  modelled from resolution, frame rate and CRF, so treat this as approximate.
                </AlertDescription>
              </Alert>
            ) : null}

            <Separator />

            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Disks
              </p>
              {estimate.disks.map((disk) => {
                const usedPct = disk.totalBytes > 0 ? (disk.usedBytes / disk.totalBytes) * 100 : 0;
                return (
                  <div key={disk.path} className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 font-mono">
                        <HardDrive className="size-3.5 text-muted-foreground" />
                        {disk.path}
                      </span>
                      {disk.ok ? (
                        <span className="tabular text-muted-foreground">
                          {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)} -{' '}
                          {formatBytes(disk.freeBytes)} available
                        </span>
                      ) : (
                        <span className="text-[var(--destructive)]">
                          {disk.error ?? 'unavailable'}
                        </span>
                      )}
                    </div>
                    <Progress value={usedPct} />
                  </div>
                );
              })}
            </div>

            {estimate.estimate.breakdown.length > 0 ? (
              <>
                <Separator />
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card">
                      <TableRow>
                        <TableHead>Degradation / level</TableHead>
                        <TableHead className="text-right">Outputs</TableHead>
                        <TableHead className="text-right">Estimated size</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {estimate.estimate.breakdown.map((row) => (
                        <TableRow key={`${row.degradation}-${row.level}`}>
                          <TableCell className="font-mono text-xs">{row.label}</TableCell>
                          <TableCell className="tabular text-right text-xs">
                            {formatNumber(row.outputs)}
                          </TableCell>
                          <TableCell className="tabular text-right text-xs">
                            {formatBytes(row.estimatedBytes)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular text-lg font-semibold">{value}</p>
    </div>
  );
}
