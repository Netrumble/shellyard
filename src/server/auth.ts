import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// Whoever reaches this server gets a shell as the user. It only listens on loopback, but a
// web page open in the user's browser can still send requests to loopback, so every request
// is checked: a secret token, the Host header (DNS rebinding) and the Origin.
//
// The token is never an ambient credential. A cookie for 127.0.0.1 is sent by the browser to
// every port on the machine, so any other local server the user visits would receive it. The
// page keeps the token itself and sends it explicitly: in a header on API calls, and in the
// subprotocol list of the WebSocket handshake (the one place a browser lets a page put it).

export const WS_PROTOCOL = 'cvm';
export const WS_TOKEN_PREFIX = 'cvm-token.';

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function requestAuthorized(headers: IncomingHttpHeaders, token: string): boolean {
  if (!token) return false;
  const given = headers['x-cvm-token'];
  return typeof given === 'string' && safeEqual(given, token);
}

/**
 * The token a WebSocket client offered in Sec-WebSocket-Protocol, as "cvm, cvm-token.<token>".
 * Null unless both the protocol name and a token are there.
 */
export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  const offered = header.split(',').map((p) => p.trim());
  if (!offered.includes(WS_PROTOCOL)) return null;
  const entry = offered.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  const token = entry ? entry.slice(WS_TOKEN_PREFIX.length) : '';
  return token || null;
}
