import { getJob } from '@/server/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 86_400;

/**
 * Server-sent events for one job.
 *
 * Progress and log lines are pushed as they happen rather than polled, which
 * keeps the UI live during a run that may take hours. The stream closes itself
 * when the job finishes; a heartbeat comment keeps intermediaries from timing
 * the connection out while a long encode is in flight.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = getJob(id);

  if (!job) {
    return new Response(`event: error\ndata: ${JSON.stringify({ error: 'Unknown job.' })}\n\n`, {
      status: 404,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const encoder = new TextEncoder();
  let unsubscribe: Array<() => void> = [];
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        for (const off of unsubscribe) off();
        unsubscribe = [];
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };

      // Prime the client with the current state and recent history, so a page
      // reload mid-run shows everything rather than starting from blank.
      send('snapshot', job.snapshot());
      send('logs', job.getLogs().slice(-200));

      unsubscribe.push(job.on('snapshot', (snapshot) => send('snapshot', snapshot)));
      unsubscribe.push(job.on('log', (entry) => send('log', entry)));
      unsubscribe.push(
        job.on('done', (snapshot) => {
          send('done', snapshot);
          cleanup();
        }),
      );

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          cleanup();
        }
      }, 15_000);

      request.signal.addEventListener('abort', cleanup, { once: true });

      const status = job.getStatus();
      if (status === 'completed' || status === 'cancelled' || status === 'failed') {
        send('done', job.snapshot());
        cleanup();
      }
    },
    cancel() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell any proxy in front of the app not to buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
