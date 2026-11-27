/**
 * Follows a media query. Safari before 14 (old iPhones and iPads, the very devices the touch
 * keys are for) has no addEventListener on a MediaQueryList, only the older addListener.
 * Returns what stops following it.
 */
export function onMediaChange(list: MediaQueryList, cb: () => void): () => void {
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', cb);
    return () => list.removeEventListener('change', cb);
  }
  list.addListener(cb);
  return () => list.removeListener(cb);
}
