import { useEffect, useState } from 'react';
import { placeFor, type Place } from '../order.js';

/** What a drop target does with one drag type; `placed` shows a before/after line instead of a highlight. */
export interface DropRule {
  onDrop: (id: string, place: Place) => void;
  placed?: boolean;
}

/** Drop events already taken by an inner target, so the targets around it leave them alone. */
const taken = new WeakSet<Event>();

/** Makes an element the start of a drag carrying `id` under `type`. */
export function dragSource(type: string, id: string): { draggable: true; onDragStart: (e: React.DragEvent) => void } {
  return {
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      e.dataTransfer.setData(type, id);
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

/**
 * A drop target for the drag types in `rules` (absent or undefined: refused). Gives the class
 * to show while something is held over it (`drop-before`, `drop-after` or `drop-into`) and the
 * event handlers. `axis` is the direction the items are laid out in.
 */
export function useDropTarget(
  rules: Record<string, DropRule | undefined>,
  axis: 'x' | 'y' = 'y',
): {
  dropClass: string;
  dropProps: { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
} {
  const [hover, setHover] = useState<{ type: string; place: Place } | null>(null);
  const holding = hover !== null;

  // A drag that ends anywhere (dropped elsewhere, or cancelled) takes the line away.
  useEffect(() => {
    if (!holding) return;
    const clear = (): void => setHover(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [holding]);

  const accepted = (e: React.DragEvent): string | undefined => Object.keys(rules).find((t) => rules[t] && e.dataTransfer.types.includes(t));
  const where = (e: React.DragEvent): Place => {
    const r = e.currentTarget.getBoundingClientRect();
    return axis === 'y' ? placeFor(e.clientY - r.top, r.height) : placeFor(e.clientX - r.left, r.width);
  };

  const rule = hover ? rules[hover.type] : undefined;
  return {
    dropClass: hover && rule ? (rule.placed ? `drop-${hover.place}` : 'drop-into') : '',
    dropProps: {
      onDragOver: (e) => {
        const type = accepted(e);
        if (!type || taken.has(e.nativeEvent)) {
          if (hover) setHover(null);
          return;
        }
        taken.add(e.nativeEvent);
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const place = where(e);
        if (hover?.type !== type || hover.place !== place) setHover({ type, place });
      },
      onDragLeave: (e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(null);
      },
      onDrop: (e) => {
        setHover(null);
        const type = accepted(e);
        if (!type || taken.has(e.nativeEvent)) return;
        taken.add(e.nativeEvent);
        e.preventDefault();
        const id = e.dataTransfer.getData(type);
        if (id) rules[type]!.onDrop(id, where(e));
      },
    },
  };
}
