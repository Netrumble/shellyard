import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_LIMIT, isSearchKey, isValidPattern, searchCountText } from '../../src/web/terminal-search.js';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe('isSearchKey', () => {
  it('opens on Ctrl+Shift+F and Cmd+F', () => {
    expect(isSearchKey(key('F', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isSearchKey(key('f', { metaKey: true }))).toBe(true);
    expect(isSearchKey(key('F', { metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('leaves plain Ctrl+F, F and Alt combinations to the terminal', () => {
    expect(isSearchKey(key('f', { ctrlKey: true }))).toBe(false);
    expect(isSearchKey(key('f'))).toBe(false);
    expect(isSearchKey(key('F', { shiftKey: true }))).toBe(false);
    expect(isSearchKey(key('f', { metaKey: true, altKey: true }))).toBe(false);
    expect(isSearchKey(key('F', { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isSearchKey(key('g', { metaKey: true }))).toBe(false);
  });
});

describe('searchCountText', () => {
  it('says nothing before anything is typed', () => {
    expect(searchCountText('', { resultIndex: 0, resultCount: 3 }, false)).toBe('');
  });

  it('numbers the match on screen', () => {
    expect(searchCountText('a', { resultIndex: 1, resultCount: 3 }, false)).toBe('2 of 3');
  });

  it('says when there is nothing, when the count is past the limit, and when the pattern is wrong', () => {
    expect(searchCountText('a', { resultIndex: -1, resultCount: 0 }, false)).toBe('No results');
    expect(searchCountText('a', null, false)).toBe('No results');
    expect(searchCountText('a', { resultIndex: -1, resultCount: HIGHLIGHT_LIMIT }, false)).toBe(`More than ${HIGHLIGHT_LIMIT}`);
    expect(searchCountText('a', { resultIndex: -1, resultCount: 4 }, false)).toBe('4 found');
    expect(searchCountText('(', null, true)).toBe('Invalid pattern');
  });
});

describe('isValidPattern', () => {
  it('accepts any text, and only compilable regular expressions', () => {
    expect(isValidPattern('(', false)).toBe(true);
    expect(isValidPattern('a.*b', true)).toBe(true);
    expect(isValidPattern('(', true)).toBe(false);
  });
});
