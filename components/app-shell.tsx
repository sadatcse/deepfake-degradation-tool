'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Loader2, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import type {
  DegradationId,
  JobOptions,
  JobRequest,
  JobSnapshot,
  LogEntry,
  PreviewClip,
  Severity,
} from '@/types';
import { DEGRADATION_IDS } from '@/types';
import { defaultLevelIds } from '@/lib/degradations';
import * as api from '@/lib/api';
import type { DatasetEntry } from '@/components/app-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { DatasetPanel } from '@/components/dataset-panel';
import { DegradationPanel } from '@/components/degradation-panel';
import { EstimatePanel } from '@/components/estimate-panel';
import { FfmpegBanner } from '@/components/ffmpeg-banner';
import { FolderPicker } from '@/components/folder-picker';
import { LogPanel } from '@/components/log-panel';
import { PreviewPanel } from '@/components/preview-panel';
import { ProgressPanel } from '@/components/progress-panel';
import { ResultsPanel } from '@/components/results-panel';
import { SettingsPanel } from '@/components/settings-panel';
import { ThemeToggle } from '@/components/theme-toggle';
import { formatNumber } from '@/lib/format';

const DEFAULT_OPTIONS: JobOptions = {
  workers: 2,
  skipExisting: true,
  forceReprocess: false,
  computeChecksums: true,
  alwaysIncludeSeverityInName: false,
  baseCrf: 18,
  encoderPreset: 'veryfast',
  combinedOrder: [...DEGRADATION_IDS],
  includeCombined: false,
  outputRoot: null,
};

export function AppShell() {
  /* ------------------------------ system ------------------------------ */
  const [system, setSystem] = useState<Awaited<ReturnType<typeof api.getSystem>> | null>(null);

  const loadSystem = useCallback(async (refresh = false) => {
    try {
      setSystem(await api.getSystem(refresh));
    } catch {
      setSystem(null);
    }
  }, []);

  useEffect(() => {
    void loadSystem(false);
  }, [loadSystem]);

  /* ----------------------------- datasets ----------------------------- */
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [outputPickerOpen, setOutputPickerOpen] = useState(false);
  const [scanning, setScanning] = useState<{
    root: string;
    phase: string;
    found: number;
    probed: number;
  } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const addFolder = useCallback(async (root: string, force = false) => {
    const token = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setScanError(null);
    setScanning({ root, phase: 'walking', found: 0, probed: 0 });

    // Poll the scan progress endpoint while the (long) POST is in flight.
    const poll = setInterval(async () => {
      try {
        const { progress } = await api.getScanProgress(token);
        if (progress) {
          setScanning({
            root,
            phase: progress.phase,
            found: progress.found,
            probed: progress.probed,
          });
        }
      } catch {
        // Progress is cosmetic; ignore a failed poll.
      }
    }, 400);

    try {
      const result = await api.scanFolder(root, force, token);
      setDatasets((previous) => {
        const entry: DatasetEntry = {
          root: result.root,
          name: result.name,
          summary: result.summary,
          videos: result.videos,
          videoCount: result.videoCount,
          truncated: result.truncated,
          hasExistingOutput: result.hasExistingOutput,
          disk: result.disk,
          scannedAt: result.scannedAt,
        };
        const without = previous.filter((d) => d.root !== result.root);
        return [...without, entry];
      });
    } catch (error) {
      setScanError((error as Error).message);
    } finally {
      clearInterval(poll);
      setScanning(null);
    }
  }, []);

  const removeFolder = useCallback((root: string) => {
    setDatasets((previous) => previous.filter((d) => d.root !== root));
  }, []);

  /* ---------------------------- selection ----------------------------- */
  const [selected, setSelected] = useState<DegradationId[]>(['blur', 'noise', 'compression']);
  const [tiers, setTiers] = useState<Severity[]>(['medium']);
  const [customLevels, setCustomLevels] = useState<Partial<Record<DegradationId, string[]>>>({});
  const [options, setOptions] = useState<JobOptions>(DEFAULT_OPTIONS);

  const levels = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const id of selected) {
      map[id] = customLevels[id] ?? defaultLevelIds(id, tiers);
    }
    return map;
  }, [selected, customLevels, tiers]);

  const toggleDegradation = (id: DegradationId) => {
    setSelected((previous) =>
      previous.includes(id) ? previous.filter((d) => d !== id) : [...previous, id],
    );
  };

  const toggleTier = (tier: Severity) => {
    setTiers((previous) =>
      previous.includes(tier) ? previous.filter((t) => t !== tier) : [...previous, tier],
    );
  };

  const moveInOrder = (id: DegradationId, direction: -1 | 1) => {
    setOptions((previous) => {
      const order = [...previous.combinedOrder];
      const from = order.indexOf(id);
      if (from < 0) return previous;

      // Swap with the neighbouring *selected* entry so the visible list moves
      // by one step even when unselected degradations sit between them.
      let to = from + direction;
      while (to >= 0 && to < order.length && !selected.includes(order[to])) to += direction;
      if (to < 0 || to >= order.length) return previous;

      [order[from], order[to]] = [order[to], order[from]];
      return { ...previous, combinedOrder: order };
    });
  };

  /* ----------------------------- job state ---------------------------- */
  const [jobId, setJobId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [exported, setExported] = useState<string[] | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  const attach = useCallback((id: string) => {
    unsubscribe.current?.();
    unsubscribe.current = api.subscribeToJob(id, {
      onSnapshot: setSnapshot,
      onLog: (entry) => setLogs((previous) => [...previous.slice(-1999), entry]),
      onLogs: (entries) => setLogs(entries),
      onDone: setSnapshot,
    });
  }, []);

  // Re-attach to a run that is still going after a page reload.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { jobs } = await api.listJobs();
        const live = jobs.find((j) => j.status === 'running' || j.status === 'paused');
        if (live && !cancelled) {
          setJobId(live.id);
          setSnapshot(live);
          attach(live.id);
        }
      } catch {
        // No running job to re-attach to, which is the normal case on a cold start.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attach]);

  useEffect(() => () => unsubscribe.current?.(), []);

  /* ----------------------------- estimate ----------------------------- */
  const [estimate, setEstimate] = useState<api.EstimateResponse | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  const jobRequest: JobRequest | null = useMemo(() => {
    if (datasets.length === 0 || selected.length === 0) return null;
    if (Object.values(levels).every((list) => list.length === 0)) return null;
    return {
      roots: datasets.map((d) => d.root),
      degradations: selected,
      levels,
      options,
    };
  }, [datasets, selected, levels, options]);

  useEffect(() => {
    if (!jobRequest) {
      setEstimate(null);
      setEstimateError(null);
      return;
    }
    let cancelled = false;
    setEstimateLoading(true);

    // Debounced: the estimate re-plans every task, so do not run it on
    // every keystroke-speed change to the selection.
    const timer = setTimeout(async () => {
      try {
        const result = await api.getEstimate(jobRequest);
        if (!cancelled) {
          setEstimate(result);
          setEstimateError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setEstimate(null);
          setEstimateError((error as Error).message);
        }
      } finally {
        if (!cancelled) setEstimateLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobRequest]);

  /* ------------------------------ preview ----------------------------- */
  const [previewVideo, setPreviewVideo] = useState<string | null>(null);
  const [previewSeconds, setPreviewSeconds] = useState(4);
  const [previewClips, setPreviewClips] = useState<PreviewClip[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const previewDataset = datasets[0] ?? null;

  useEffect(() => {
    if (!previewDataset) {
      setPreviewVideo(null);
      return;
    }
    const usable = previewDataset.videos.find((v) => !v.probeError);
    setPreviewVideo((current) => current ?? usable?.relativePath ?? null);
  }, [previewDataset]);

  const generatePreview = async () => {
    if (!previewDataset || !previewVideo) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const selections = selected.flatMap((id) =>
        (levels[id] ?? []).map((level) => ({ degradation: id, level })),
      );
      const combined =
        options.includeCombined && selected.length >= 2 && tiers.length > 0
          ? {
              tier: tiers[0],
              steps: options.combinedOrder
                .filter((id) => selected.includes(id))
                .map((id) => {
                  const ids = levels[id] ?? [];
                  return { degradation: id, level: ids[0] };
                })
                .filter((step) => Boolean(step.level)),
            }
          : undefined;

      const result = await api.generatePreview({
        root: previewDataset.root,
        video: previewVideo,
        // Cap it: one clip per level would mean a long wait before any appear.
        selections: selections.slice(0, 12),
        combined,
        seconds: previewSeconds,
        options: {
          baseCrf: options.baseCrf,
          encoderPreset: 'veryfast',
          outputRoot: options.outputRoot,
        },
      });
      setPreviewClips(result.clips);
    } catch (error) {
      setPreviewError((error as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  };

  const clearPreview = async () => {
    setPreviewClips([]);
    if (previewDataset) {
      await api.clearPreviews(previewDataset.root, options.outputRoot).catch(() => {});
    }
  };

  /* ------------------------------ actions ----------------------------- */
  const ffmpegReady = Boolean(system?.ffmpeg.available && system?.ffprobe.available);
  const jobActive = snapshot?.status === 'running' || snapshot?.status === 'paused';

  const blockers: string[] = [];
  if (!ffmpegReady) blockers.push('FFmpeg and FFprobe must be installed.');
  if (datasets.length === 0) blockers.push('Select at least one input folder.');
  if (selected.length === 0) blockers.push('Select at least one degradation.');
  if (tiers.length === 0 && Object.keys(customLevels).length === 0) {
    blockers.push('Select at least one severity tier.');
  }
  if (jobRequest && Object.values(levels).some((list) => list.length === 0)) {
    blockers.push('Every selected degradation needs at least one level.');
  }
  if (estimate?.diskStatus === 'INSUFFICIENT') {
    blockers.push('Not enough free disk space for the estimated output.');
  }
  if (estimate?.outputProblem) blockers.push(estimate.outputProblem.message);

  const start = async () => {
    if (!jobRequest) return;
    setBusy(true);
    setJobError(null);
    setExported(null);
    setLogs([]);
    try {
      const result = await api.startJob(jobRequest);
      setJobId(result.jobId);
      setSnapshot(result.snapshot);
      attach(result.jobId);
    } catch (error) {
      setJobError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: api.ControlAction) => {
    if (!jobId) return;
    setBusy(true);
    setJobError(null);
    try {
      const result = await api.controlJob(jobId, action);
      setSnapshot(result.snapshot);
      if (action === 'export' && result.files) setExported(result.files);
      if (action === 'retry-failed') attach(jobId);
    } catch (error) {
      setJobError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const configDisabled = busy || jobActive;

  /* ------------------------------- render ----------------------------- */
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary">
              <Film className="size-6" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                DeepFake Bulk Video Degradation Tool
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Bulk FFmpeg degradation for deepfake detection datasets.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
              <ShieldCheck className="size-3.5 text-[var(--success)]" />
              Runs locally - no database, no cloud, no upload
            </span>
            <ThemeToggle />
          </div>
        </div>

        <FfmpegBanner system={system} onRecheck={() => loadSystem(true)} />
      </header>

      {scanError ? (
        <Alert variant="destructive" className="mb-4">
          <TriangleAlert />
          <AlertTitle>Scan failed</AlertTitle>
          <AlertDescription className="break-path">{scanError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <DatasetPanel
            datasets={datasets}
            scanning={scanning}
            disabled={configDisabled}
            onAdd={() => setPickerOpen(true)}
            onRemove={removeFolder}
            onRescan={(root) => void addFolder(root, true)}
          />

          <DegradationPanel
            selected={selected}
            tiers={tiers}
            levels={levels}
            customised={Object.keys(customLevels) as DegradationId[]}
            includeCombined={options.includeCombined}
            combinedOrder={options.combinedOrder}
            disabled={configDisabled}
            onToggleDegradation={toggleDegradation}
            onToggleTier={toggleTier}
            onSetLevels={(id, levelIds) =>
              setCustomLevels((previous) => ({ ...previous, [id]: levelIds }))
            }
            onResetLevels={(id) =>
              setCustomLevels((previous) => {
                const next = { ...previous };
                delete next[id];
                return next;
              })
            }
            onToggleCombined={(value) =>
              setOptions((previous) => ({ ...previous, includeCombined: value }))
            }
            onMoveInOrder={moveInOrder}
          />

          {previewDataset ? (
            <PreviewPanel
              videos={previewDataset.videos}
              clips={previewClips}
              loading={previewLoading}
              error={previewError}
              disabled={configDisabled || !ffmpegReady}
              selectedVideo={previewVideo}
              seconds={previewSeconds}
              onSelectVideo={setPreviewVideo}
              onSecondsChange={setPreviewSeconds}
              onGenerate={() => void generatePreview()}
              onClear={() => void clearPreview()}
            />
          ) : null}
        </div>

        <div className="space-y-4">
          <SettingsPanel
            options={options}
            cpuCount={system?.cpuCount ?? 1}
            disabled={configDisabled}
            resolvedOutputRoots={estimate?.outputRoots ?? []}
            onChange={(patch) => setOptions((previous) => ({ ...previous, ...patch }))}
            onBrowseOutput={() => setOutputPickerOpen(true)}
          />

          <EstimatePanel
            estimate={estimate}
            loading={estimateLoading}
            error={estimateError}
          />

          <Card>
            <CardContent className="space-y-3 pt-5">
              {jobError ? (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <AlertTitle>Job error</AlertTitle>
                  <AlertDescription className="break-path">{jobError}</AlertDescription>
                </Alert>
              ) : null}

              {blockers.length > 0 ? (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {blockers.map((blocker) => (
                    <li key={blocker} className="flex items-start gap-1.5">
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--warning)]" />
                      {blocker}
                    </li>
                  ))}
                </ul>
              ) : null}

              <Button
                size="xl"
                className="w-full"
                disabled={blockers.length > 0 || busy || jobActive || !jobRequest}
                onClick={() => void start()}
              >
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                {jobActive ? 'Processing...' : 'Start bulk processing'}
              </Button>

              {estimate && blockers.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground">
                  Will create {formatNumber(estimate.estimate.totalOutputs)} output files across{' '}
                  {datasets.length} folder{datasets.length === 1 ? '' : 's'}.
                </p>
              ) : null}

              {exported ? (
                <>
                  <Separator />
                  <div className="space-y-1">
                    <p className="text-xs font-medium">Exported:</p>
                    {exported.map((file) => (
                      <p key={file} className="break-path font-mono text-[11px] text-muted-foreground">
                        {file}
                      </p>
                    ))}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      {snapshot ? (
        <div className="mt-4 space-y-4">
          <ProgressPanel
            snapshot={snapshot}
            busy={busy}
            onPause={() => void control('pause')}
            onResume={() => void control('resume')}
            onCancel={() => void control('cancel')}
            onRetryFailed={() => void control('retry-failed')}
            onExport={() => void control('export')}
          />

          <div className="grid gap-4 xl:grid-cols-2">
            <LogPanel logs={logs} onClear={() => setLogs([])} />
            {jobId ? (
              <ResultsPanel
                jobId={jobId}
                revision={snapshot.counts.completed + snapshot.counts.failed + snapshot.counts.skipped}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      <FolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(path) => void addFolder(path)}
      />

      <FolderPicker
        open={outputPickerOpen}
        onOpenChange={setOutputPickerOpen}
        onSelect={(path) => setOptions((previous) => ({ ...previous, outputRoot: path }))}
        title="Select output folder"
        description="Every dataset gets its own subfolder here. Pick a folder outside your datasets - one inside would be picked up as input on the next scan."
        confirmLabel="Use as output folder"
      />

      <footer className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
        <p>
          Original videos are never modified, renamed, moved or deleted. All output is written to a
          separate degraded_output/ folder inside each dataset, together with metadata.json,
          metadata.csv, manifest.json and processing_log.json.
        </p>
      </footer>
    </div>
  );
}
