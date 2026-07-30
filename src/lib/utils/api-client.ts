/**
 * The browser side of the API envelope.
 *
 * Every route returns `{ success: true, data }` or `{ success: false, error }` with a
 * bilingual message already in it, which is the whole reason this is eight lines and
 * not a client library: the server has already decided what the user should be told,
 * so the job here is to stop throwing away that message.
 *
 * A rejected promise is deliberately not how a refusal arrives. `fetch` rejects for
 * a dropped connection and resolves for a 422, and a caller that only catches would
 * show "something went wrong" for a validation error that came with an exact
 * explanation of which field was wrong.
 */

export interface ApiError {
  readonly code: string;
  readonly messageAr: string;
  readonly messageEn: string;
  readonly field?: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const NETWORK_ERROR: ApiError = {
  code: 'NETWORK_ERROR',
  messageAr: 'تعذّر الوصول إلى الخادم. تحقّق من اتصالك وحاول مرة أخرى.',
  messageEn: 'Could not reach the server. Check your connection and try again.',
};

const MALFORMED_RESPONSE: ApiError = {
  code: 'MALFORMED_RESPONSE',
  messageAr: 'وردت من الخادم استجابة غير مفهومة.',
  messageEn: 'The server returned a response this client could not read.',
};

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: MALFORMED_RESPONSE };
  }

  if (typeof body !== 'object' || body === null || !('success' in body)) {
    return { ok: false, error: MALFORMED_RESPONSE };
  }

  const envelope = body as
    | { success: true; data: T }
    | { success: false; error: ApiError };

  if (envelope.success) return { ok: true, data: envelope.data };
  return { ok: false, error: envelope.error };
}

export function apiPost<T>(url: string, payload: unknown): Promise<ApiResult<T>> {
  return apiFetch<T>(url, { method: 'POST', body: JSON.stringify(payload) });
}
