import { useEffect, useId, useRef, useState } from 'react';
import { useEscape } from '../escape.js';

/** The open panel: closes on Escape and on a click outside, and puts the focus in itself. */
function Panel(props: { id: string; label: string; anchor: React.RefObject<HTMLElement | null>; onClose: (refocus: boolean) => void; children: React.ReactNode; align: 'start' | 'end' }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(props.onClose);
  latest.current = props.onClose;
  const { anchor } = props;
  useEscape(() => latest.current(true));

  // Once, on opening: the page re-renders every second, and the focus must stay where it is.
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button, select, input, [href]')?.focus();
    const outside = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      latest.current(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [anchor]);

  return (
    <div ref={box} id={props.id} className={`popover popover-${props.align}`} role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

/**
 * A button that shows a small panel of controls under it (a disclosure: Tab moves through the
 * controls, Escape closes and returns to the button). `children` gets a function that closes it.
 */
export function Popover(props: {
  label: string;
  buttonClass?: string;
  button: React.ReactNode;
  align?: 'start' | 'end';
  children: (close: () => void) => React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) anchor.current?.focus();
  };
  return (
    <span className="popover-anchor">
      <button
        ref={anchor}
        type="button"
        className={props.buttonClass ?? 'icon-button'}
        aria-label={props.label}
        title={props.label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {props.button}
      </button>
      {open && (
        <Panel id={id} label={props.label} anchor={anchor} onClose={close} align={props.align ?? 'end'}>
          {props.children(() => close(true))}
        </Panel>
      )}
    </span>
  );
}
