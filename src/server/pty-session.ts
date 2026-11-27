import nodePty from '@lydell/node-pty';
import serializePkg from '@xterm/addon-serialize';
import headlessPkg from '@xterm/headless';
import graphemesPkg from '@xterm/addon-unicode-graphemes';
import type { Launch } from './shells.js';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
const { UnicodeGraphemesAddon } = graphemesPkg;

export const SCROLLBACK_LINES = 5000;

export interface PtyLike {
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtyOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** The serialized screen of a session, and the size it had when it was serialized. */
export interface Snapshot {
  data: string;
  cols: number;
  rows: number;
}

export type PtyFactory =(launch: Launch, opts: PtyOptions) => PtyLike;

/**
 * The options node-pty spawns a session with. On Windows the output passes through a ConPTY,
 * which lays each line out by its own idea of character widths before the terminals see it.
 * The one shipped with node-pty, not the system's, is used: a system conhost of an older
 * Windows counts an emoji with U+FE0F as one cell where the terminals (15-graphemes) count
 * two, which shifts the rest of the line; the bundled one counts two on every Windows.
 */
export function spawnOptions(opts: PtyOptions, platform: NodeJS.Platform = process.platform): Parameters<typeof nodePty.spawn>[2] {
  return {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
    ...(platform === 'win32' ? { useConptyDll: true } : {}),
  };
}

export const realPtyFactory: PtyFactory = (launch, opts) => nodePty.spawn(launch.file, launch.args, spawnOptions(opts));

/**
 * One pseudo-terminal process plus a headless terminal fed with the same bytes.
 * The mirror is what lets a browser that attaches later get the current screen back,
 * including full-screen programs, which a raw replay of the byte stream would not restore.
 */
export class PtySession {
  private readonly pty: PtyLike;
  private readonly mirror: InstanceType<typeof Terminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private readonly outputCbs: Array<(data: string) => void> = [];
  private readonly exitCbs: Array<(exitCode: number) => void> = [];
  private exited = false;
  private _cols: number;
  private _rows: number;

  constructor(factory: PtyFactory, launch: Launch, opts: PtyOptions) {
    this._cols = opts.cols;
    this._rows = opts.rows;
    this.pty = factory(launch, opts);
    this.mirror = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    // Count emoji and other wide characters as two cells, as the browser terminal does, so the
    // screen a later viewer restores lines up with the one live viewers saw.
    this.mirror.loadAddon(new UnicodeGraphemesAddon());
    this.mirror.unicode.activeVersion = '15-graphemes';
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.pty.onData((data) => {
      for (const cb of this.outputCbs) cb(data);
      try {
        this.mirror.write(data);
      } catch {
        // The headless terminal refuses data once its backlog is huge. Live viewers already
        // have this chunk; only the restored screen of a later viewer would miss it.
      }
    });
    this.pty.onExit((e) => {
      if (this.exited) return;
      this.exited = true;
      for (const cb of this.exitCbs) cb(e.exitCode);
    });
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  onOutput(cb: (data: string) => void): void {
    this.outputCbs.push(cb);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitCbs.push(cb);
  }

  write(data: string): void {
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    // A hidden or collapsed container measures as 0x0; never shrink a terminal to nothing.
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return;
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /**
   * Serialized screen and scrollback covering exactly the output received before this call.
   * The mirror parses asynchronously, so an empty write marks the cut and the screen is
   * serialized inside its callback: output arriving after the call is parsed later and is
   * not in the snapshot. A caller that starts buffering live output at the moment of the
   * call can therefore send snapshot + buffer with nothing lost and nothing doubled.
   * The size is the one the screen had as it was serialized: the one to draw it at.
   */
  snapshot(): Promise<Snapshot> {
    return new Promise<Snapshot>((resolve) => {
      this.mirror.write('', () => resolve({ data: this.serializer.serialize(), cols: this.mirror.cols, rows: this.mirror.rows }));
    });
  }

  kill(): void {
    // Killing a pty whose process is already gone makes node-pty's Windows helper throw.
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch {
      // The process may have ended between the check and the call.
    }
  }

  dispose(): void {
    this.mirror.dispose();
  }
}
