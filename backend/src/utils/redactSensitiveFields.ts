/**
 * Sensitive field redaction utility for audit logging.
 *
 * Any field whose key — normalized to lowercase with separators stripped —
 * matches an entry in REDACTED_FIELDS will have its value replaced with
 * '[REDACTED]' before the data is written to an audit log or logger.
 * Nested objects and arrays are redacted recursively.
 */

export const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'apisecret',
  'secret',
  'signingsecret',
  'webhooksecret',
  'privatekey',
  'cardnumber',
  'cvv',
  'cvc',
  'pan',
  'ssn',
  'dob',
  'authorization',
  'cookie',
  'xapikey',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Query parameter names whose values must never be written to logs.
 * Matched case-insensitively against the decoded parameter name.
 */
export const REDACTED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'token',
  'ticket',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'api_key',
  'apiKey',
  'apikey',
  'secret',
  'password',
  'authorization',
]);

const REDACTED_QUERY_VALUE = '[REDACTED]';

/**
 * Strip credential-bearing query parameters (e.g. `token`, `ticket`) from a
 * URL or request-target string so it can be safely written to access logs.
 *
 * Works on full URLs (`https://host/path?a=b`) and bare request targets
 * (`/path?a=b`). Non-sensitive parameters, ordering and the fragment are
 * preserved. If the input cannot be parsed it is returned unchanged.
 */
export function redactUrlQueryParams(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;

  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return url;

  const fragmentIndex = url.indexOf('#', queryIndex);
  const base = url.slice(0, queryIndex);
  const query =
    fragmentIndex === -1
      ? url.slice(queryIndex + 1)
      : url.slice(queryIndex + 1, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      if (pair.length === 0) return pair;
      const eqIndex = pair.indexOf('=');
      const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
      let decodedKey = rawKey;
      try {
        decodedKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // Malformed percent-encoding — fall back to the raw key.
      }
      if (!REDACTED_QUERY_PARAMS.has(decodedKey)) return pair;
      return `${rawKey}=${REDACTED_QUERY_VALUE}`;
    })
    .join('&');

  return `${base}?${redactedQuery}${fragment}`;
}

/**
 * Recursively redact sensitive keys from a plain object or array.
 * Returns a new value — the original is never mutated.
 */
export function redactSensitiveFields(
  data: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth > 10) return data; // guard against circular references

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (REDACTED_FIELDS.has(normalizeKey(key))) {
      result[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactSensitiveFields(item as Record<string, unknown>, depth + 1)
          : item,
      );
    } else if (value !== null && typeof value === 'object') {
      result[key] = redactSensitiveFields(value as Record<string, unknown>, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}
