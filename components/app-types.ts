import type { DiskInfo, ScanSummary, VideoMetadata } from '@/types';

/** One selected input folder, as held in client state. */
export interface DatasetEntry {
  root: string;
  name: string;
  summary: ScanSummary;
  /** Capped sample used for the metadata table; the server holds them all. */
  videos: VideoMetadata[];
  videoCount: number;
  truncated: boolean;
  hasExistingOutput: boolean;
  disk: DiskInfo;
  scannedAt: string;
}
