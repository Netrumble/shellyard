import { useEffect } from 'react';
import { digestText, FOCUS_MINUTES, focusOn, minutesLeft } from '../focus.js';
import { notifyDigest } from '../notify.js';
import { dismissDigest, endFocus, setView, startFocusNow, useStore } from '../store.js';
import { useNow } from './Cluster.js';

/**
 * Focus for 45 minutes: only permissions and questions interrupt; sessions that finish meanwhile
 * come in one digest at the end. A switch in the header; on, it says when the digest comes.
 */
export function FocusSwitch(): React.JSX.Element {
  const { focus, sound } = useStore();
  const now = useNow(5_000);
  const on = focusOn(focus, now);

  // The end comes by itself: the digest is shown, and notified if the page is not in view.
  useEffect(() => {
    if (focus && !on) {
      const names = endFocus();
      notifyDigest(digestText(names), () => setView({ kind: 'attention' }), sound);
    }
  }, [focus, on, sound]);

  const at = focus ? new Date(focus.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={on ? 'focus-switch on' : 'focus-switch'}
      title={on ? 'End the focus now and see what finished' : `For ${FOCUS_MINUTES} minutes only permissions and questions interrupt; finished sessions come in a digest at the end`}
      onClick={() => (on ? endFocus() : startFocusNow())}
    >
      <span className="focus-text">
        <span className="focus-title">{on && focus ? `Focus · ${minutesLeft(focus, now)} min left` : `Focus ${FOCUS_MINUTES} min`}</span>
        {on && <span className="focus-note">Only permissions and questions interrupt · digest at {at}</span>}
      </span>
      <span className="focus-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

/** What finished during the focus, until dismissed. */
export function DigestBanner(): React.JSX.Element | null {
  const { digestShown } = useStore();
  if (!digestShown) return null;
  return (
    <div className="digest" role="status">
      <span>{digestText(digestShown)}</span>
      {digestShown.length > 0 && (
        <button
          type="button"
          onClick={() => {
            dismissDigest();
            setView({ kind: 'attention' });
          }}
        >
          Open the queue
        </button>
      )}
      <button type="button" className="ny-link" onClick={dismissDigest}>
        Dismiss
      </button>
    </div>
  );
}
