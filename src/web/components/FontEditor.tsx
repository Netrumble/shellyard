import { useEffect, useState } from 'react';
import type { TerminalFont } from '../../shared/types.js';
import { DEFAULT_FONT_SIZE, FONT_CHOICES, terminalFont } from '../terminal-look.js';

const OTHER = '__other__';
const SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28, 32];

/**
 * Chooses the font and the text size of a terminal. Both come from lists, so that every
 * change is a complete choice; a font that is not in the list can be typed by name.
 */
export function FontEditor({ value, onChange }: { value: TerminalFont | null; onChange: (v: TerminalFont | null) => void }): React.JSX.Element {
  const family = value?.family ?? null;
  const size = value?.size ?? null;
  const listed = family === null || FONT_CHOICES.includes(family);
  const [other, setOther] = useState(!listed);
  const [typed, setTyped] = useState(listed ? '' : (family ?? ''));

  useEffect(() => {
    if (family !== null && !FONT_CHOICES.includes(family)) {
      setOther(true);
      setTyped(family);
    }
  }, [family]);

  const emit = (nextFamily: string | null, nextSize: number | null): void => onChange(nextFamily === null && nextSize === null ? null : { family: nextFamily, size: nextSize });
  const sizes = size !== null && !SIZES.includes(size) ? [...SIZES, size].sort((a, b) => a - b) : SIZES;
  const look = terminalFont(value);

  return (
    <div className="font-editor">
      <div className="font-row">
        <label>
          <span>Font</span>
          <select
            value={other ? OTHER : (family ?? '')}
            onChange={(e) => {
              const v = e.target.value;
              setOther(v === OTHER);
              if (v !== OTHER) emit(v || null, size);
            }}
          >
            <option value="">Default (Cascadia Mono)</option>
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
        </label>
        <label>
          <span>Size</span>
          <select value={size ?? ''} onChange={(e) => emit(other ? typed.trim() || null : family, e.target.value ? Number(e.target.value) : null)}>
            <option value="">Default ({DEFAULT_FONT_SIZE})</option>
            {sizes.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {other && (
        <label className="font-other">
          <span>Font name</span>
          <input
            value={typed}
            maxLength={60}
            spellCheck={false}
            placeholder="As it is named on this computer"
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => emit(typed.trim() || null, size)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              emit(typed.trim() || null, size);
            }}
          />
        </label>
      )}
      <div className="font-preview" style={{ fontFamily: look.fontFamily, fontSize: `${look.fontSize}px` }} aria-hidden="true">
        PS C:\repos&gt; git status 0O 1lI
      </div>
      <p className="hint">A font must be installed on the computer the browser runs on; otherwise the default is used.</p>
    </div>
  );
}
