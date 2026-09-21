'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, ScrollText, Trash2 } from 'lucide-react';
import type { LogEntry } from '@/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { formatClock } from '@/lib/format';

interface Props {
  logs: LogEntry[];
  onClear: () => void;
}

const LEVEL_COLOUR: Record<LogEntry['level'], string> = {
  info: 'text-muted-foreground',
  success: 'text-[var(--success)]',
  warn: 'text-[var(--warning)]',
  error: 'text-[var(--destructive)]',
};

/** Live processing log with clear / copy / download (spec 22). */
export function LogPanel({ logs, onClear }: Props) {
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, follow]);

  const asText = () =>
    logs.map((l) => `[${formatClock(l.ts)}] ${l.level.toUpperCase()} ${l.message}`).join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the download button still works.
    }
  };

  const download = () => {
    const blob = new Blob([asText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `degradation-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-muted-foreground" />
            Processing log
          </CardTitle>
          <CardDescription>
            Also written to degraded_output/processing_log.json and logs/ in the app folder.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <Switch id="follow" checked={follow} onCheckedChange={setFollow} />
            <Label htmlFor="follow" className="text-xs text-muted-foreground">
              Follow
            </Label>
          </div>
          <Button variant="ghost" size="sm" onClick={copy} disabled={logs.length === 0}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="ghost" size="sm" onClick={download} disabled={logs.length === 0}>
            <Download />
            Download
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={logs.length === 0}>
            <Trash2 />
            Clear
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <div className="h-72 overflow-y-auto rounded-lg border border-border bg-[var(--background)] p-3">
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No log output yet.</p>
          ) : (
            <div className="space-y-0.5 font-mono text-xs leading-relaxed">
              {logs.map((entry, index) => (
                <div key={`${entry.ts}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">[{formatClock(entry.ts)}]</span>
                  <span className={`break-path ${LEVEL_COLOUR[entry.level]}`}>{entry.message}</span>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
