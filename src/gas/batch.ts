/**
 * Google Calendar batch requests (multipart/mixed, up to 50 calls per HTTP request).
 * Pure functions, so they can be tested without Apps Script.
 */

export const BATCH_URL = 'https://www.googleapis.com/batch/calendar/v3';
export const BATCH_SIZE = 50;

export interface BatchRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface BatchItemResult {
  /** HTTP status of the individual call; 0 = no answer for this item. */
  status: number;
  body: unknown;
}

export function buildBatchBody(reqs: BatchRequest[], boundary: string): string {
  let out = '';
  reqs.forEach((r, i) => {
    out += `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\n`;
    out += `${r.method} ${r.path} HTTP/1.1\r\n`;
    if (r.body !== undefined) {
      out += `Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(r.body)}\r\n`;
    } else {
      out += '\r\n';
    }
  });
  return out + `--${boundary}--`;
}

/** Splits a batch response into per-item results, matched by Content-ID (not by order). */
export function parseBatchResponse(text: string, contentType: string, count: number): BatchItemResult[] {
  const results: BatchItemResult[] = Array.from({ length: count }, () => ({ status: 0, body: null }));
  const bm = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  const boundary = bm ? bm[1] ?? bm[2] : null;
  const parts = boundary ? text.split('--' + boundary) : [text];
  for (const part of parts) {
    const id = /Content-ID:\s*<?response-item(\d+)>?/i.exec(part);
    const st = /HTTP\/1\.1\s+(\d{3})/.exec(part);
    if (!id || !st) continue;
    const idx = +id[1];
    if (idx < 0 || idx >= count) continue;
    const after = part.slice(st.index);
    const sep = after.search(/\r?\n\r?\n/);
    let body: unknown = null;
    if (sep >= 0) {
      const raw = after.slice(sep).trim();
      if (raw) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
    }
    results[idx] = { status: +st[1], body };
  }
  return results;
}

/** Error reason from a Google API error body, e.g. "rateLimitExceeded". */
export function errorReason(body: unknown): string {
  const e = (body as { error?: { errors?: Array<{ reason?: string }>; message?: string } } | null)?.error;
  return e?.errors?.[0]?.reason ?? '';
}

export function errorMessage(body: unknown): string {
  const e = (body as { error?: { message?: string } } | null)?.error;
  if (e?.message) return e.message;
  return typeof body === 'string' ? body.slice(0, 200) : '';
}

export function isRetryable(status: number, body: unknown): boolean {
  if (status === 0 || status === 429 || status >= 500) return true;
  if (status === 403) return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(errorReason(body));
  return false;
}
