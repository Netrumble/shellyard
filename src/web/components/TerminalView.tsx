import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { TerminalBackground, TerminalFont } from '../../shared/types.js';
import { backgroundUrl } from '../api.js';
import { getSocket, getState, onThemeChange } from '../store.js';
import { hostStyle, terminalFont, terminalLook } from '../terminal-look.js';

const RESIZE_DEBOUNCE_MS = 100;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * The real terminal of one session. It attaches on mount (and again after a reconnect),
 * receives the restored screen followed by live output, and sends back keystrokes and its
 * size. A session must be mounted in only one place at a time: a terminal has one size.
 */
export function TerminalView(props: {
  sessionId: string;
  autoFocus?: boolean;
  onFocusChange?: (focused: boolean) => void;
  /** What is behind the text; null or absent follows the theme. */
  background?: TerminalBackground | null;
  /** The font and text size; null or absent is the default. */
  font?: TerminalFont | null;
}): React.JSX.Element {
  const { sessionId, autoFocus } = props;
  const host = useRef<HTMLDivElement>(null);
  const onFocusChange = useRef(props.onFocusChange);
  onFocusChange.current = props.onFocusChange;
  const background = props.background ?? null;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  /** Applies the current background and theme to the terminal that is open. */
  const applyLook = useRef<() => void>(() => undefined);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const font = props.font ?? null;
  const fontRef = useRef(font);
  fontRef.current = font;
  /** Applies the current font to the terminal that is open, and fits it again. */
  const applyFont = useRef<() => void>(() => undefined);

  // A stored image is fetched once and drawn behind the terminal, under its veil.
  useEffect(() => {
    let current = true;
    setImageUrl(null);
    if (background?.image) {
      backgroundUrl(background.image).then(
        (url) => current && setImageUrl(url),
        () => undefined,
      );
    }
    return () => {
      current = false;
    };
  }, [background?.image]);

  useEffect(() => {
    applyLook.current();
  }, [background?.color, background?.image, background?.veil]);

  useEffect(() => {
    applyFont.current();
  }, [font?.family, font?.size]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const socket = getSocket();
    // Programs colour their output for a dark terminal. On the light theme the terminal is
    // light too, and xterm is asked to keep every colour readable against it: it darkens a
    // foreground that would otherwise be pale on pale.
    // A background chosen for this terminal comes before the theme: a colour, or an image
    // behind a transparent terminal.
    const look = (): { theme: { background: string; foreground: string; cursor: string; selectionBackground: string }; minimumContrastRatio: number } => {
      const theme = getState().theme;
      const chosen = terminalLook(backgroundRef.current, theme, { termBg: cssVar('--term-bg', '#0c0d10'), termFg: cssVar('--term-fg', '#d7dae0') });
      return {
        theme: {
          background: chosen.background,
          foreground: chosen.foreground,
          cursor: cssVar('--accent', '#e5484d'),
          selectionBackground: chosen.lightText ? '#3d4f6b' : '#b6d0f7',
        },
        minimumContrastRatio: chosen.minimumContrastRatio,
      };
    };
    const term = new Terminal({
      ...terminalFont(fontRef.current),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // Needed for an image to show through; it has to be decided when the terminal is made.
      allowTransparency: true,
      ...look(),
    });
    applyLook.current = () => {
      const next = look();
      term.options.theme = next.theme;
      term.options.minimumContrastRatio = next.minimumContrastRatio;
    };
    const offTheme = onThemeChange(() => applyLook.current());
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const safeFit = (): void => {
      // A hidden container has no size; fitting then would shrink the terminal to nothing.
      if (el.clientWidth < 20 || el.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        // xterm can throw while its renderer is not ready yet; the next resize fits it.
      }
    };

    const attach = (): void => {
      safeFit();
      socket.send({ t: 'attach', id: sessionId, cols: term.cols, rows: term.rows });
    };

    const unsubscribe = socket.subscribe(sessionId, (m) => {
      if (m.t === 'snapshot') term.reset();
      term.write(m.data);
    });
    const offState = socket.onState((s) => {
      if (s === 'open') attach();
    });
    if (socket.state() === 'open') attach();

    const input = term.onData((data) => socket.send({ t: 'input', id: sessionId, data }));

    // Ctrl+C copies when there is a selection (otherwise it interrupts, as in any terminal),
    // and Ctrl+V is left to the browser so that its paste event reaches the terminal.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (key === 'v') return false;
      return true;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = term.cols;
    let lastRows = term.rows;
    const refit = (): void => {
      safeFit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        socket.send({ t: 'resize', id: sessionId, cols: term.cols, rows: term.rows });
      }
    };
    // Another font or size changes how many columns and rows fit: the session is told.
    applyFont.current = () => {
      const next = terminalFont(fontRef.current);
      if (term.options.fontFamily === next.fontFamily && term.options.fontSize === next.fontSize) return;
      term.options.fontFamily = next.fontFamily;
      term.options.fontSize = next.fontSize;
      refit();
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(refit, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(el);

    const onFocusIn = (): void => onFocusChange.current?.(true);
    const onFocusOut = (): void => onFocusChange.current?.(false);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    if (autoFocus) term.focus();

    return () => {
      clearTimeout(timer);
      observer.disconnect();
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
      input.dispose();
      applyLook.current = () => undefined;
      applyFont.current = () => undefined;
      offTheme();
      offState();
      unsubscribe();
      socket.send({ t: 'detach', id: sessionId });
      term.dispose();
    };
  }, [sessionId, autoFocus]);

  const style = background?.color ? { background: background.color } : hostStyle(background, imageUrl);
  return <div className="terminal-host" ref={host} style={style} data-background={background?.image ? 'image' : background?.color ? 'color' : 'theme'} />;
}
