import { useEffect, useState } from 'react';

/** Below this width the page is laid out for a phone: the sidebar becomes a drawer. Keep in step with theme.css. */
export const NARROW_QUERY = '(max-width: 700px)';

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** True while the window is phone-narrow; follows rotation and resizing. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
