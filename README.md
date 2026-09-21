# DeepFake Bulk Video Degradation Tool

A local desktop-style web application for building degraded copies of a video
dataset in bulk, for deepfake detection research.

Point it at a folder of videos, choose the degradations and severities, and it
produces a complete `degraded_output/` tree alongside the originals, with full
metadata, checksums and lineage for every file it creates.

**No database. No cloud. No upload.** Everything runs on the machine you start
it on, and videos never leave it.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Run](#run)
- [Workflow](#workflow)
- [Output layout](#output-layout)
- [Choosing where output goes](#choosing-where-output-goes)
- [Degradations](#degradations)
- [Generated files](#generated-files)
- [Resume, skip and retry](#resume-skip-and-retry)
- [Concurrency and performance](#concurrency-and-performance)
- [Security](#security)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## What it does

1. You select one or more input folders.
2. It scans them recursively for `.mp4 .mov .avi .mkv .webm` and reads every
   file's duration, resolution, frame rate, codec and bitrate with `ffprobe`.
3. You choose degradations (blur, noise, compression, ...) and severity tiers
   (mild / medium / severe), or pick exact levels per degradation.
4. It shows the exact output count, the exact parameters (`CRF 34`,
   `sigma 3.33`, `short side 480px`) and an estimate of the disk space needed.
5. You can preview a few seconds of one sample video through each degradation
   before committing.
6. It processes everything with a bounded pool of `ffmpeg` processes, streaming
   progress and logs live.
7. It writes `metadata.json`, `metadata.csv`, `manifest.json` and
   `processing_log.json` describing every output.

**Original videos are never modified, renamed, moved or deleted.**

---

## Requirements

| | |
|---|---|
| Node.js | 20.11 or newer (22+ recommended) |
| FFmpeg | any recent build, with `ffmpeg` **and** `ffprobe` on `PATH` |
| OS | Windows, macOS or Linux |

### Installing FFmpeg

```bash
winget install Gyan.FFmpeg      # Windows
brew install ffmpeg             # macOS
sudo apt install ffmpeg         # Debian / Ubuntu
sudo dnf install ffmpeg         # Fedora
sudo pacman -S ffmpeg           # Arch
```

On Windows, close and reopen your terminal afterwards so the new `PATH` is
picked up. Verify with:

```bash
ffmpeg -version
ffprobe -version
```

The app detects both at startup and refuses to start a job without them,
showing these instructions and a **Re-check** button.

If you would rather not touch `PATH`, put absolute paths in `.env` instead:

```ini
FFMPEG_PATH=C:\tools\ffmpeg\bin\ffmpeg.exe
FFPROBE_PATH=C:\tools\ffmpeg\bin\ffprobe.exe
```

---

## Install

```bash
npm install
```

---

## Run

```bash
npm run dev
```

Then open <http://localhost:4321>.

For a production build:

```bash
npm run build
npm start
```

The server binds to localhost only. It is a local tool, not a shared service -
anyone who can reach it can read and write files as the user running it. Do not
expose the port to a network you do not trust.

---

## Workflow

```
SELECT FOLDER -> SCAN -> SELECT DEGRADATIONS -> SELECT SEVERITY
     -> ESTIMATE -> PREVIEW -> START -> FFMPEG BULK PROCESSING
     -> OUTPUT FOLDERS -> METADATA -> VALIDATE -> EXPORT
```

**Selecting a folder.** A browser cannot hand a real filesystem path to a web
page, and uploading the videos is out of the question. So the folder picker
browses the filesystem *of the machine the server runs on* - which is your own
machine - and returns a real absolute path. You can also type or paste a path
directly. Nothing is uploaded at any point.

**Severity.** The three tiers are multi-select. Selecting all three runs every
chosen degradation three times. Degradations with a richer menu than three
levels - resolution, frame rate, frame drop - map their menu onto the tiers, and
the exact level is always shown. Use the slider icon on any selected degradation
to pick precise levels instead.

**Combined.** With two or more degradations selected you can add a `combined/`
output that chains them in a configurable order. The pipeline is shown as
`Blur -> Noise -> Compression` before you start, and all stages are applied in a
single decode/encode pass rather than once per stage.

---

## Output layout

For an input folder `Dataset-01/`:

```
Dataset-01/
    video001.mp4                        <- untouched
    video002.mp4                        <- untouched

    degraded_output/
        blur/
            video001_blur.mp4
            video002_blur.mp4
        noise/
            video001_noise.mp4
            video002_noise.mp4
        compression/
        low_resolution/
        fps_reduction/
        frame_drop/
        motion_blur/
        brightness/
        contrast/
        saturation/
        combined/

        metadata.json
        metadata.csv
        manifest.json
        processing_log.json
        README.txt
```

This is the default. To write elsewhere, see
[Choosing where output goes](#choosing-where-output-goes).

### Folder structure is preserved

A nested dataset keeps its shape under every degradation folder:

```
Dataset/                         degraded_output/blur/
    real/v1.mp4          ->          real/v1_blur.mp4
    fake/v2.mp4          ->          fake/v2_blur.mp4
```

`train/`, `validation/` and `test/` folders are detected, preserved and never
mixed. The split is recorded in the metadata for each file.

### Filenames

With one severity selected you get `video001_blur.mp4`. As soon as more than one
level of the same degradation is queued the level is appended -
`video001_blur_mild.mp4`, `video001_blur_severe.mp4` - because two severities
cannot share a filename.

Turn on **Always include severity in filename** to get the long form every time.
That is the safer choice when you build a dataset across several sessions: it
prevents a second run at a different severity from colliding with the first.
The tool also detects that case at runtime and reports it rather than silently
treating the old file as the new one.

---

## Choosing where output goes

By default, output is written to `degraded_output/` **inside each input folder**,
so a dataset and its degraded copies travel together.

Set **Output folder** in Processing settings to send everything somewhere else -
another drive, a scratch volume, a NAS mount. Each dataset then gets its own
subfolder there, named after the input folder:

```
Output folder:  E:\renders

D:\Dataset-01   ->   E:\renders\Dataset-01\blur\train\real\v1_blur.mp4
D:\Dataset-02   ->   E:\renders\Dataset-02\blur\v9_blur.mp4
```

Everything else is unchanged: the source folder structure is still mirrored, and
each dataset still gets its own `metadata.json`, `metadata.csv`, `manifest.json`
and `processing_log.json` inside its subfolder. Resume, skip-existing and retry
all work exactly as before - they simply look in the new location.

The subfolder is always created, even for a single dataset. That keeps the
layout stable: if it were flat for one folder and nested for two, adding a
second dataset would move the first one's output and break its resume.

The panel shows the resolved destination before you start, so there is no
guessing about where files will land.

### What is rejected, and why

The app refuses an output folder that would corrupt a later run, and says which
case it hit:

| Rejected | Reason |
|---|---|
| Output folder **inside** an input folder | The scanner only ignores a folder named `degraded_output`. Output anywhere else under a dataset would be found as *input* on the next scan, quietly feeding degraded videos back through the pipeline. |
| Output folder **is** an input folder | Same problem, and it would mix generated files in with the originals. |
| Output folder **contains** an input folder | The same enclosing-folder hazard, in reverse. |
| Two selected datasets with the **same folder name** | Both would resolve to one subfolder and overwrite each other's metadata. Rename one, process them separately, or use the default layout (where each output stays beside its own dataset). |

Note that the last one only applies to a custom output folder. With the default
layout, two folders both called `videos` are perfectly fine - each keeps its
output beside itself.

Disk space is checked on the volume you are **writing to**, which with a custom
output folder may be a different drive from the input entirely.

Preview clips follow the same setting: they go to a `.previews` folder inside
the output location.

---

## Degradations

| Degradation | Implementation | Mild | Medium | Severe |
|---|---|---|---|---|
| Blur | `gblur` | radius 5 (sigma 1.67) | radius 10 (sigma 3.33) | radius 20 (sigma 6.67) |
| Noise | `noise=alls=N:allf=t+u` | 10 | 25 | 50 |
| Compression | libx264 CRF | CRF 28 | CRF 34 | CRF 40 |
| Low resolution | `scale` | 720p | 480p | 240p |
| FPS reduction | `fps` | 24 | 15 | 5 |
| Frame drop | `select` | 5% | 10% | 30% |
| Motion blur | `tmix` | 3 frames | 5 frames | 9 frames |
| Brightness | `eq=brightness` | -10% | -25% | -50% |
| Contrast | `eq=contrast` | 0.85 | 0.65 | 0.45 |
| Saturation | `eq=saturation` | 0.75 | 0.50 | 0.20 |

Additional levels available per degradation: resolution `360p`, frame rate `30`
and `10`, frame drop `20%`.

### Implementation notes

**Blur** uses a gaussian kernel rather than a box blur, because that is what
the deepfake-robustness literature normally means by "blur". The spec is
expressed as a pixel radius, so `sigma = radius / 3` is used and both numbers are
recorded in the metadata.

**Low resolution** treats "480p" as *the shorter side is 480px*, so portrait
clips are handled the same way as landscape. Aspect ratio is always preserved
and the source is never upscaled - a 360p source asked for 720p is reported as
skipped, because an upscaled copy is not a degradation.

**FPS reduction** reads the source rate first and skips rather than resampling
upwards.

**Frame drop** keeps a frame when `mod(n * percent, 100) >= percent`. That gives
exactly the requested rate, spreads the losses evenly instead of dropping them
in bursts, and is fully deterministic, so a re-run reproduces the same dataset.
Timestamps are deliberately not rebased: combined with constant-frame-rate
output the clip keeps its original duration and holds the previous frame over
each gap, reproducing the stutter of a lossy capture rather than simply
producing a shorter file.

**Non-compression degradations** are encoded at CRF 18 (configurable) so that a
blur output is degraded by the blur and not by the encode.

**Audio** is stream-copied when the source codec fits in an MP4 container, and
re-encoded to AAC otherwise. Sources with no audio produce no audio track.

---

## Generated files

### `metadata.json`

One record per output:

```json
{
  "source": "real/video001.mp4",
  "sourceAbsolute": "D:\\Dataset-01\\real\\video001.mp4",
  "output": "blur/real/video001_blur.mp4",
  "degradation": "blur",
  "severity": "medium",
  "level": "medium",
  "parameters": { "radius": 10, "sigma": 3.333, "steps": 2, "filter": "gblur" },
  "filterChain": "gblur=sigma=3.333:steps=2",
  "status": "completed",
  "processedAt": "2026-09-19T12:31:04.812Z",
  "processingMs": 2140,
  "originalSha256": "9f2c...",
  "outputSha256": "41ab...",
  "sourceSizeBytes": 5242880,
  "outputSizeBytes": 3981204,
  "durationSec": 12.4,
  "width": 1920, "height": 1080, "fps": 30,
  "codec": "h264",
  "split": null,
  "error": null
}
```

### `metadata.csv`

`source_file, output_file, degradation, severity, level, duration, width,
height, fps, codec, status, processing_time, source_size_bytes,
output_size_bytes, original_sha256, output_sha256, split, parameters,
filter_chain, processed_at, error`

### `manifest.json`

Dataset-level summary: input folder, totals, the degradations and severities
used, the full options the run was configured with, and a `files` array mapping
each source to every output derived from it.

### `processing_log.json`

One entry per run (keyed by job id), with counts, options and the full log.

All four are written incrementally during the run and finalised at the end, so a
crash never leaves you with nothing. Writes are atomic (temp file + rename).

---

## Resume, skip and retry

- **Skip existing** (on by default) leaves a finished output alone. Output is
  written to a `.part` file and renamed only after ffmpeg exits cleanly, so a
  file that exists is a file that finished - the skip is always safe to trust.
- **Resume** needs nothing special. Restart the app, select the same folder and
  the same settings, and start: everything already produced is skipped and the
  run continues where it stopped. State is recovered from the output files and
  `metadata.json`, not from any database.
- **Force reprocess** re-encodes everything, overwriting existing output.
- **Retry failed** requeues only the failed tasks.
- A corrupt or unreadable video is marked `failed` (or `skipped`, if ffprobe
  could not read it at scan time) and the batch carries on.

---

## Concurrency and performance

Workers are selectable: 1, 2, 4, 6, 8 (default 2). That is the maximum number of
concurrent `ffmpeg` processes; the pool never exceeds it regardless of how many
videos are queued.

More workers is not automatically faster. x264 is already multi-threaded, so 2-4
workers usually saturates a desktop CPU; beyond that the processes mostly
compete with each other.

Videos are never loaded into memory. `ffmpeg` is spawned with
`child_process.spawn` and streams from the source file to the output file; the
only data read back is ffmpeg's own progress on stdout. Memory use is therefore
flat whether the dataset has 10 videos or 10,000.

Checksums stream too, with a 1 MB buffer, and a source hash is computed once per
run and reused across all of that video's outputs. Turn checksums off to avoid a
full extra read of every file.

---

## Security

The server reads and writes real files, so the boundaries are explicit:

- Every path from a request is resolved and normalised; traversal sequences and
  NUL bytes are rejected.
- Every output write is checked to be inside that dataset's own
  `degraded_output/` folder before anything is created.
- The media endpoint only serves files inside the `degraded_output/` folder of a
  dataset scanned in the current session. Source videos are never served, and no
  other path on the machine is reachable through it.
- Set `ALLOWED_ROOTS` in `.env` to confine the whole application to specific
  folders - worth doing if you leave it running.

---

## Configuration

Everything is optional; see `.env.example`.

| Variable | Meaning |
|---|---|
| `FFMPEG_PATH` | absolute path to `ffmpeg` (default: resolve from `PATH`) |
| `FFPROBE_PATH` | absolute path to `ffprobe` (default: resolve from `PATH`) |
| `ALLOWED_ROOTS` | comma-separated folders the app may touch (default: unrestricted) |

---

## Project structure

```
deepfake-degradation-tool/
├── app/                        Next.js App Router
│   ├── api/                    route handlers (scan, estimate, preview, jobs, fs, media)
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── components/                 React components
│   └── ui/                     shadcn/ui primitives
├── lib/                        shared client+server code (catalogue, schemas, api client)
├── processors/                 one module per degradation
│   ├── blur.ts  noise.ts  compression.ts  resolution.ts
│   ├── fps.ts   frameDrop.ts   motionBlur.ts
│   ├── brightness.ts  contrast.ts  saturation.ts
│   └── combined.ts  registry.ts
├── services/                   ffmpeg, ffprobe, scanner, planner,
│                               processing, metadata, checksum, storage, preview
├── server/                     process state (scan cache, job registry) + http helpers
├── types/                      shared domain types
├── utils/                      paths (security), concurrency, csv
├── tests/                      logic tests (no ffmpeg required)
├── logs/                       per-job application logs
└── public/
```

Processors are pure functions: they take a level and the source's probe data and
return the ffmpeg fragments needed, doing no I/O. That is what makes the filter
chain visible in the UI before anything runs, and what lets the tests verify
every degradation without ffmpeg installed.

---

## Development

```bash
npm run dev         # dev server on :4321
npm run build       # production build
npm test            # logic tests - no ffmpeg needed
npm run typecheck   # tsc --noEmit
```

The test suite covers the filter chains, the no-upscale and no-fps-increase
guarantees, the exact frame-drop rate, combined-pipeline merging, output naming
and collision-avoidance, folder-structure preservation, split separation, path
containment, CSV escaping and the size estimator.

---

## Troubleshooting

**"FFmpeg is not installed or not available in PATH."**
Install it (see above) and press **Re-check**. On Windows, open a new terminal
first. If it is installed somewhere unusual, set `FFMPEG_PATH` and
`FFPROBE_PATH` in `.env`.

**Scanning is slow on a large folder.**
Scanning runs `ffprobe` once per file, 8 at a time. Ten thousand files takes a
few minutes on a cold filesystem cache, and results are cached for the session.

**Everything is being skipped.**
Output already exists. Turn on **Force reprocess**, or delete
`degraded_output/`.

**"Output already exists but was produced at level ... "**
An earlier run wrote the same filename at a different severity. Turn on
**Always include severity in filename**, or use **Force reprocess**.

**"The output folder sits inside the input folder ..."**
Output kept under a dataset would be picked up as input the next time you scan
it. Choose a folder outside your datasets, or leave the setting blank to use the
default `degraded_output/`, which the scanner always ignores.

**Estimates do not match the real output size.**
They are modelled from resolution, frame rate, CRF and how compressible each
degradation leaves the picture. Treat them as a guide, particularly for noise,
which is expensive to encode and varies a lot with content.
