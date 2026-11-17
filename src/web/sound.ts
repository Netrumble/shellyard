let context: AudioContext | null = null;

/** A short, soft two-note chime. Silent if the browser will not allow audio yet. */
export function chime(): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    const start = ctx.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = start + i * 0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    }
  } catch {
    // Audio is an extra; a browser that refuses it changes nothing else.
  }
}
