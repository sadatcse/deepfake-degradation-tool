/** Shared helpers for the route handlers. */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, init);
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

/**
 * Turn anything thrown inside a route into a useful JSON response.
 * Zod issues are flattened into a single readable sentence.
 */
export function handleError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    const detail = error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    return fail(`Invalid request - ${detail}`, 422);
  }

  const message = error instanceof Error ? error.message : String(error);

  // Missing ffmpeg is the single most common setup problem; give it its own
  // status so the UI can show the install instructions instead of a red toast.
  if (message.includes('not installed or not available in PATH')) {
    return fail(message, 503);
  }
  if (message.startsWith('Refusing to touch') || message.includes('outside ALLOWED_ROOTS')) {
    return fail(message, 403);
  }
  if (message.startsWith('Folder not found') || message.includes('not found')) {
    return fail(message, 404);
  }

  return fail(message, 500);
}

/** Route handlers must never be cached or statically evaluated. */
export const routeConfig = {
  dynamic: 'force-dynamic' as const,
  runtime: 'nodejs' as const,
};
