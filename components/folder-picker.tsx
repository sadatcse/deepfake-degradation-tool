'use client';

import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Search,
} from 'lucide-react';
import type { DirEntry } from '@/types';
import { folderPathFormSchema, type FolderPathForm } from '@/lib/schemas';
import * as api from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  /** Reused for both the input dataset and the output destination. */
  title?: string;
  description?: string;
  confirmLabel?: string;
}

/**
 * Server-side folder browser (spec 40).
 *
 * A browser cannot hand a real filesystem path to a page, and uploading the
 * videos is out of the question - they must never leave the machine. So the
 * picker walks the filesystem of the host the app runs on, which is the user's
 * own machine, and returns a real absolute path. A path can also be typed or
 * pasted directly.
 */
export function FolderPicker({
  open,
  onOpenChange,
  onSelect,
  title = 'Select input folder',
  description = 'Browsing this computer. Videos are never uploaded anywhere - the app only reads the folder you choose.',
  confirmLabel = 'Use this folder',
}: Props) {
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [roots, setRoots] = useState<DirEntry[]>([]);
  const [videoFilesHere, setVideoFilesHere] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FolderPathForm>({
    resolver: zodResolver(folderPathFormSchema),
    defaultValues: { path: '' },
    mode: 'onSubmit',
  });

  const typed = form.watch('path');

  const navigate = useCallback(
    async (target?: string) => {
      setLoading(true);
      setError(null);
      try {
        const listing = await api.listDir(target);
        setCurrent(listing.path);
        setParent(listing.parent);
        setEntries(listing.entries);
        setRoots(listing.roots);
        setVideoFilesHere(listing.videoFilesHere ?? 0);
        // Keep the field in step with the folder actually being shown.
        if (listing.path) form.setValue('path', listing.path, { shouldValidate: false });
        if (listing.error) setError(listing.error);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [form],
  );

  useEffect(() => {
    if (open) {
      form.reset({ path: '' });
      void navigate(undefined);
    }
  }, [open, navigate, form]);

  /** Submitting the field navigates to it; the resolver rejects a bad path first. */
  const onSubmitPath = form.handleSubmit(({ path }) => navigate(path));

  const confirm = (path: string | null) => {
    const target = (path ?? typed ?? '').trim();
    if (!target) return;
    onSelect(target);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmitPath} noValidate>
          <div className="flex gap-2">
            <Input
              {...form.register('path')}
              // Radix Dialog swallows the default Enter-to-submit, so submit
              // explicitly - typing a path and pressing Enter is the fast path.
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void onSubmitPath();
                }
              }}
              placeholder="Type or paste a folder path, e.g. D:\Deepfake\Dataset-01"
              className="font-mono text-xs"
              spellCheck={false}
              aria-invalid={form.formState.errors.path ? true : undefined}
            />
            <Button type="submit" variant="outline" disabled={loading}>
              <Search />
              Go
            </Button>
          </div>
          {form.formState.errors.path ? (
            <p className="mt-1.5 text-xs text-[var(--destructive)]">
              {form.formState.errors.path.message}
            </p>
          ) : null}
        </form>

        <div className="flex flex-wrap gap-1.5">
          {roots.map((root) => (
            <Button
              key={root.path}
              variant="secondary"
              size="sm"
              onClick={() => void navigate(root.path)}
              className="h-7 font-mono text-xs"
            >
              <HardDrive />
              {root.name}
            </Button>
          ))}
        </div>

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="break-path font-mono text-xs">
                {current ?? 'Choose a drive or type a path'}
              </span>
            </div>
            {videoFilesHere > 0 ? (
              <Badge variant="success" className="shrink-0">
                {videoFilesHere} video{videoFilesHere === 1 ? '' : 's'} here
              </Badge>
            ) : null}
          </div>

          <ScrollArea className="h-72">
            <div className="p-1">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Reading folder...
                </div>
              ) : null}

              {!loading && parent ? (
                <button
                  type="button"
                  onClick={() => void navigate(parent)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <CornerLeftUp className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Parent folder</span>
                </button>
              ) : null}

              {!loading &&
                entries.map((entry) => (
                  <div key={entry.path} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void navigate(entry.path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                      <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs"
                      onClick={() => confirm(entry.path)}
                    >
                      Use
                    </Button>
                  </div>
                ))}

              {!loading && current && entries.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No subfolders here.
                  {videoFilesHere > 0
                    ? ' This folder contains videos - use it directly.'
                    : ' Nothing to scan in this folder.'}
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </div>

        {error ? <p className="text-sm text-[var(--destructive)]">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => confirm(current)} disabled={!current && !typed.trim()}>
            <FolderOpen />
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
