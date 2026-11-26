import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module of the desktop app, without types
import { isDetachedWindowUrl } from '../../desktop/windows.js';

const ORIGIN = 'http://0123456789abcdef0123456789abcdef.localhost:7717';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('isDetachedWindowUrl', () => {
  it("allows a session's own window on the server of this start", () => {
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}`, ORIGIN)).toBe(true);
  });

  it('refuses other origins, other paths and other addresses', () => {
    expect(isDetachedWindowUrl(`http://evil.example/?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`http://127.0.0.1:7717/?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/api/sessions?detached=${ID}`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=nope`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}&x=1`, ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl('not a url', ORIGIN)).toBe(false);
    expect(isDetachedWindowUrl(`${ORIGIN}/?detached=${ID}`, null)).toBe(false);
  });
});
