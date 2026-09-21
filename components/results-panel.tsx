'use client';

import { useCallback, useEffect, useState } from 'react';
import { ListChecks, Loader2, RefreshCw } from 'lucide-react';
import type { TaskStatus } from '@/types';
import * as api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatMs, formatNumber } from '@/lib/format';

interface Props {
  jobId: string;
  /** Bumped by the parent whenever the job advances, to refresh the page. */
  revision: number;
}

const FILTERS: Array<{ id: TaskStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'skipped', label: 'Skipped' },
  { id: 'pending', label: 'Pending' },
  { id: 'running', label: 'Running' },
];

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'muted' | 'default'> = {
  completed: 'success',
  failed: 'destructive',
  skipped: 'warning',
  pending: 'muted',
  running: 'default',
  cancelled: 'muted',
};

const PAGE_SIZE = 50;

/** Per-output results, with lineage and checksums (spec 23, 30, 31). */
export function ResultsPanel({ jobId, revision }: Props) {
  const [status, setStatus] = useState<TaskStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<api.TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getTasks(jobId, {
        status: status === 'all' ? undefined : status,
        q: query || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setRows(result.tasks);
      setTotal(result.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [jobId, status, query, offset]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  useEffect(() => {
    setOffset(0);
  }, [status, query]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground" />
            Outputs
          </CardTitle>
          <CardDescription>
            Every planned output and what happened to it. Full records are in metadata.json and
            metadata.csv.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.id}
              variant={status === filter.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatus(filter.id)}
            >
              {filter.label}
            </Button>
          ))}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by filename..."
            className="h-8 w-56 font-mono text-xs"
          />
          <span className="tabular text-xs text-muted-foreground">
            {formatNumber(total)} row{total === 1 ? '' : 's'}
          </span>
        </div>

        <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Degradation</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing to show for this filter.
                  </TableCell>
                </TableRow>
              ) : null}

              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-56">
                    <span className="break-path font-mono text-xs">{row.sourceRelative}</span>
                    {row.sourceSha256 ? (
                      <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                        sha256 {row.sourceSha256.slice(0, 16)}...
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span className="break-path font-mono text-xs">{row.outputRelative}</span>
                    {row.outputSha256 ? (
                      <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                        sha256 {row.outputSha256.slice(0, 16)}...
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline">{row.degradation}</Badge>
                      <Badge variant="secondary">{row.level}</Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[row.status] ?? 'muted'}>{row.status}</Badge>
                    {row.error ? (
                      <p className="mt-1 max-w-64 break-path text-[11px] text-[var(--destructive)]">
                        {row.error}
                      </p>
                    ) : null}
                    {row.skipReason ? (
                      <p className="mt-1 max-w-64 break-path text-[11px] text-muted-foreground">
                        {row.skipReason}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular text-right text-xs">
                    {formatMs(row.processingMs)}
                  </TableCell>
                  <TableCell className="tabular text-right text-xs">
                    {formatBytes(row.outputSizeBytes)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <span className="tabular text-xs text-muted-foreground">
              {formatNumber(offset + 1)} - {formatNumber(Math.min(offset + PAGE_SIZE, total))} of{' '}
              {formatNumber(total)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || loading}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading...
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
