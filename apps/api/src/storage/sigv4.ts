/**
 * Minimal AWS SigV4 implementation for Cloudflare R2 over plain `fetch`.
 * Credentials are passed explicitly so an ambient AWS_PROFILE or local AWS
 * config can never be used. Scoped to PUT, GET, HEAD, and DELETE operations.
 */
import { createHash, createHmac } from 'node:crypto';

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
};

/** R2 ignores region but SigV4 requires one in the scope. `auto` is R2's. */
const REGION = 'auto';
const SERVICE = 's3';

export const sha256hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/**
 * RFC3986 encoding. `encodeURIComponent` leaves !'()* alone and S3 does not,
 * so a key containing them would sign differently from how it is sent. Works
 * on UTF-8 BYTES: a per-UTF-16-unit `%XX` would mis-encode any non-ASCII key.
 */
export function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(str, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === '/' && !encodeSlash) out += '/';
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export type SignedRequest = { url: string; headers: Record<string, string> };

export type SignInput = {
  method: string;
  canonicalUri: string;
  /** Every header that goes on the wire, `host` included. All are signed. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
};

/** Returns the `Authorization` header value. */
export function signV4(i: SignInput): string {
  if (!i.accessKeyId || !i.secretAccessKey) {
    throw new Error('R2 credentials are missing — refusing to sign an unauthenticated request');
  }
  const dateStamp = i.amzDate.slice(0, 8);

  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(i.headers)) {
    lower.set(k.toLowerCase(), String(v).trim().replace(/\s+/g, ' '));
  }
  const names = [...lower.keys()].sort();
  const canonicalHeaders = names.map((h) => `${h}:${lower.get(h)}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    i.method,
    i.canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${i.region}/${i.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, dateStamp), i.region), i.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return (
    `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

/**
 * Signs one path-style R2 request. `body` is hashed in full rather than sent as
 * UNSIGNED-PAYLOAD, so a body altered in transit fails the signature instead of
 * landing as a different object.
 */
export function sign(
  creds: R2Credentials,
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
  key: string,
  body?: Buffer,
  extraHeaders: Record<string, string> = {},
  now = new Date(),
): SignedRequest {
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error('R2 credentials are missing — refusing to sign an unauthenticated request');
  }
  const host = new URL(creds.endpoint).host;
  const canonicalUri = `/${uriEncode(creds.bucket, false)}/${uriEncode(key, false)}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = sha256hex(body ?? '');

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const authorization = signV4({
    method,
    canonicalUri,
    headers,
    payloadHash,
    region: REGION,
    service: SERVICE,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    amzDate,
  });

  return {
    url: `${creds.endpoint.replace(/\/$/, '')}${canonicalUri}`,
    headers: { ...headers, Authorization: authorization },
  };
}
