'use client';

import { useState } from 'react';
import { Eye, Loader2, Trash2, TriangleAlert } from 'lucide-react';
import type { PreviewClip, VideoMetadata } from '@/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
import { formatBytes } from '@/lib/format';

interface Props {
  videos: VideoMetadata[];
  clips: PreviewClip[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  selectedVideo: string | null;
  seconds: number;
  onSelectVideo: (relativePath: string) => void;
  onSecondsChange: (seconds: number) => void;
  onGenerate: () => void;
  onClear: () => void;
}

/**
 * Sample preview (spec 17).
 *
 * Encodes a few seconds of one video through each selected degradation so the
 * settings can be judged on screen before committing to thousands of files.
 */
export function PreviewPanel({
  videos,
  clips,
  loading,
  error,
  disabled,
  selectedVideo,
  seconds,
  onSelectVideo,
  onSecondsChange,
  onGenerate,
  onClear,
}: Props) {
  const [playing, setPlaying] = useState<string | null>(null);
  const usable = videos.filter((v) => !v.probeError);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="size-4 text-muted-foreground" />
          Preview
        </CardTitle>
        <CardDescription>
          Check the settings on one sample before processing the whole folder. Preview clips are
          written to a .previews folder inside the output location and are never part of the
          dataset.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Sample video
            </Label>
            <Select
              value={selectedVideo ?? undefined}
              disabled={disabled || usable.length === 0}
              onValueChange={onSelectVideo}
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Choose a video" />
              </SelectTrigger>
              <SelectContent>
                {usable.slice(0, 200).map((video) => (
                  <SelectItem key={video.relativePath} value={video.relativePath}>
                    {video.relativePath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-32">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Seconds</Label>
            <Select
              value={String(seconds)}
              disabled={disabled}
              onValueChange={(value) => onSecondsChange(Number(value))}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[2, 4, 6, 10].map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}s
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={onGenerate} disabled={disabled || loading || !selectedVideo}>
            {loading ? <Loader2 className="animate-spin" /> : <Eye />}
            {loading ? 'Encoding samples...' : 'Generate previews'}
          </Button>

          {clips.length > 0 ? (
            <Button variant="ghost" onClick={onClear} disabled={loading}>
              <Trash2 />
              Clear
            </Button>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Preview failed</AlertTitle>
            <AlertDescription className="break-path">{error}</AlertDescription>
          </Alert>
        ) : null}

        {clips.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {clips.map((clip) => (
              <div
                key={`${clip.degradation}-${clip.level}`}
                className="overflow-hidden rounded-lg border border-border"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <span className="truncate text-sm font-medium">{clip.label}</span>
                  {clip.degradation === 'original' ? (
                    <Badge variant="outline">reference</Badge>
                  ) : (
                    <Badge variant="secondary" className="font-mono">
                      {clip.summary}
                    </Badge>
                  )}
                </div>

                {clip.error ? (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {clip.error}
                  </p>
                ) : (
                  <>
                    <video
                      src={clip.url}
                      controls
                      loop
                      muted
                      playsInline
                      preload="metadata"
                      className="aspect-video w-full bg-black"
                      onPlay={() => setPlaying(clip.url)}
                      onPause={() => setPlaying((p) => (p === clip.url ? null : p))}
                    />
                    <div className="space-y-1 px-3 py-2">
                      <p className="break-path font-mono text-[11px] text-muted-foreground">
                        {clip.filterChain}
                      </p>
                      <p className="tabular text-[11px] text-muted-foreground">
                        {formatBytes(clip.sizeBytes)}
                        {playing === clip.url ? ' - playing' : ''}
                      </p>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
