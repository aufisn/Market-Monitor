/** Response helpers: JSON, security headers, bounded body reading. */
import { ApiError } from "./validate";

/** Strict CSP for API/JSON responses (S-5). The page shell gets its own via static asset headers. */
export const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });
}

export function text(body: string, status: number, contentType: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...API_HEADERS, "content-type": contentType, ...extra } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return json({ error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status);
  return json({ error: "INTERNAL", message: "Something went wrong on the server." }, 500);
}

/** Reads and parses a JSON body with a hard size cap. */
export async function readJson(request: Request, maxBytes = 65_536): Promise<unknown> {
  const ct = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON with content-type application/json.");
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > maxBytes) throw new ApiError(413, "TOO_LARGE", "Request body is too large.");
  const body = await request.text();
  if (body.length > maxBytes) throw new ApiError(413, "TOO_LARGE", "Request body is too large.");
  try {
    return JSON.parse(body);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Body is not valid JSON.");
  }
}
