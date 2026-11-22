import { useEffect, useState } from 'react';
import { SCHEDULE_PERMISSION_MODES, type Schedule, type SchedulePermissionMode, type ScheduleWhen } from '../../shared/types.js';
import { api } from '../api.js';
import { durationLabel } from '../gauges.js';
import { describeWhen, fromLocalInput, outcomeText, outcomeTone, runResult, toLocalInput, WEEK, whenLabel } from '../schedule-text.js';
import { refreshMeta, setView, useStore } from '../store.js';
import { FolderPicker } from './FolderPicker.js';

const MODE_TEXT: Record<SchedulePermissionMode, string> = {
  default: 'As Claude Code is set up',
  manual: 'Ask before every action',
  acceptEdits: 'Edit files without asking',
  auto: 'Auto: decide what is safe to do without asking',
  plan: 'Plan only: change nothing',
};

type Kind = ScheduleWhen['kind'];
const DEFAULT_MODEL = '';

/** Creates a schedule, or edits the one given. */
function ScheduleDialog({ schedule, onClose }: { schedule?: Schedule; onClose: () => void }): React.JSX.Element {
  const { meta, stories } = useStore();
  const claudeProfiles = meta.profiles.filter((p) => p.kind === 'claude');
  const w = schedule?.when;
  const [name, setName] = useState(schedule?.name ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [profileId, setProfileId] = useState(schedule?.profileId ?? claudeProfiles[0]?.id ?? '');
  const [model, setModel] = useState(schedule?.model ?? DEFAULT_MODEL);
  const [cwd, setCwd] = useState(schedule?.cwd ?? '');
  const [storyId, setStoryId] = useState(schedule?.storyId ?? '');
  const [kind, setKind] = useState<Kind>(w?.kind ?? 'weekly');
  const [time, setTime] = useState(w?.kind === 'weekly' ? w.time : '08:30');
  const [days, setDays] = useState<number[]>(w?.kind === 'weekly' ? w.days : [1, 2, 3, 4, 5]);
  const [every, setEvery] = useState(w?.kind === 'interval' ? (w.minutes % 60 === 0 ? w.minutes / 60 : w.minutes) : 2);
  const [unit, setUnit] = useState<'minutes' | 'hours'>(w?.kind === 'interval' && w.minutes % 60 !== 0 ? 'minutes' : 'hours');
  const [at, setAt] = useState(toLocalInput(w?.kind === 'once' ? w.at : Date.now() + 3_600_000));
  const [expr, setExpr] = useState(w?.kind === 'cron' ? w.expr : '0 9 * * 1-5');
  const [catchUp, setCatchUp] = useState(schedule?.catchUp ?? false);
  const [permissionMode, setPermissionMode] = useState<SchedulePermissionMode>(schedule?.permissionMode ?? 'default');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshMeta();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const profile = meta.profiles.find((p) => p.id === profileId);
  const area = stories.find((s) => s.id === storyId);
  const models = model && !meta.models.includes(model) ? [...meta.models, model] : meta.models;

  const when = (): ScheduleWhen | string => {
    if (kind === 'weekly') return { kind, time, days };
    if (kind === 'interval') return { kind, minutes: Math.round(every * (unit === 'hours' ? 60 : 1)) };
    if (kind === 'cron') return { kind, expr };
    const moment = fromLocalInput(at);
    return moment === null ? 'Give the date and time of the run.' : { kind: 'once', at: moment };
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const chosen = when();
    if (typeof chosen === 'string') {
      setError(chosen);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The timetable is sent only when it was changed: an unchanged one keeps its next run.
      const sameWhen = schedule !== undefined && JSON.stringify(chosen) === JSON.stringify(schedule.when);
      const fields = { name, prompt, profileId, model: model || null, cwd, storyId: area ? area.id : null, catchUp, permissionMode, ...(sameWhen ? {} : { when: chosen }) };
      if (schedule) await api.updateSchedule(schedule.id, fields);
      else await api.createSchedule(fields);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleDay = (day: number): void => setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog wide" onSubmit={(e) => void submit(e)} aria-label={schedule ? 'Edit schedule' : 'New schedule'}>
        <h2>{schedule ? 'Edit schedule' : 'New schedule'}</h2>

        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Also the name of the sessions it starts" maxLength={80} autoFocus />
        </label>

        <div className="field">
          <span id="schedule-prompt-label">Prompt</span>
          <textarea
            aria-labelledby="schedule-prompt-label"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="What Claude Code is asked to do each time, exactly as you would type it"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <span id="schedule-when-label">Runs</span>
          <div className="schedule-when" role="group" aria-labelledby="schedule-when-label">
            <div className="segmented">
              {(['weekly', 'interval', 'once', 'cron'] as const).map((k) => (
                <button key={k} type="button" className={kind === k ? 'active' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === 'weekly' ? 'On days' : k === 'interval' ? 'Every' : k === 'once' ? 'Once' : 'Cron'}
                </button>
              ))}
            </div>
            {kind === 'weekly' && (
              <div className="schedule-row">
                <div className="day-picks">
                  {WEEK.map((d) => (
                    <button key={d.day} type="button" className={days.includes(d.day) ? 'day on' : 'day'} aria-pressed={days.includes(d.day)} onClick={() => toggleDay(d.day)}>
                      {d.short}
                    </button>
                  ))}
                </div>
                <span>at</span>
                <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} required />
              </div>
            )}
            {kind === 'interval' && (
              <div className="schedule-row">
                <input type="number" aria-label="How many" min={1} max={unit === 'hours' ? 168 : 10080} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
                <select aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')}>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
                <span className="hint">counted from the last run; 5 minutes at least</span>
              </div>
            )}
            {kind === 'once' && (
              <div className="schedule-row">
                <input type="datetime-local" aria-label="Date and time" value={at} onChange={(e) => setAt(e.target.value)} />
              </div>
            )}
            {kind === 'cron' && (
              <div className="schedule-row">
                <input className="cron" aria-label="Cron expression" value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} />
                <span className="hint">minute, hour, day of month, month, weekday</span>
              </div>
            )}
            <span className="hint">Times are this computer&apos;s local time.</span>
          </div>
        </div>

        <label>
          <span>Launcher</span>
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {!profile && <option value={profileId}>{profileId ? 'A launcher that no longer exists' : 'No Claude Code launcher found'}</option>}
            {claudeProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value={DEFAULT_MODEL}>{profile?.model ? `Launcher default (${profile.model})` : 'Default'}</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Area</span>
          <select value={area ? area.id : ''} onChange={(e) => setStoryId(e.target.value)}>
            <option value="">No area</option>
            {stories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span id="schedule-folder-label">Folder</span>
          <FolderPicker value={cwd} onChange={setCwd} placeholder={area?.cwd || profile?.cwd || 'Your home folder'} start={area?.cwd || profile?.cwd} labelledBy="schedule-folder-label" />
        </div>

        <label>
          <span>Permissions</span>
          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as SchedulePermissionMode)}>
            {SCHEDULE_PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_TEXT[m]}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Nobody may be at the screen when it runs. When Claude Code asks for a permission, the session waits and shows under &quot;Needs
          attention&quot; until you answer.
        </p>

        <label className="check">
          <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
          <span>If ShellYard was not running at the time, run once when it next starts</span>
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {schedule ? 'Save' : 'Create schedule'}
          </button>
        </div>
      </form>
    </div>
  );
}

function nextText(s: Schedule, now: number): string {
  if (!s.enabled) return s.when.kind === 'once' && s.runs.length > 0 ? 'Done' : 'Paused';
  if (s.nextRunAt === null) return 'No further run';
  const wait = s.nextRunAt - now;
  return wait <= 0 ? 'Due now' : `${whenLabel(s.nextRunAt)} (in ${durationLabel(wait)})`;
}

/** The prompts ShellYard gives to new Claude Code sessions at set times. */
export function SchedulesView(): React.JSX.Element {
  const { schedules, sessions, stories, meta } = useStore();
  const [dialog, setDialog] = useState<{ schedule?: Schedule } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setBeat] = useState(0);

  // "in 12m" goes stale; a slow beat keeps it honest.
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const report = (e: unknown): void => setError((e as Error).message);
  const act = (p: Promise<unknown>): void => {
    setError(null);
    p.catch(report);
  };
  const runNow = (s: Schedule): void => {
    setError(null);
    api.runSchedule(s.id).then((run) => {
      if (run.outcome === 'failed') setError(`"${s.name}" could not start: ${run.detail ?? 'unknown reason'}`);
    }, report);
  };

  const now = Date.now();
  return (
    <div className="schedules">
      <p>
        A schedule starts a new Claude Code session at set times and gives it a prompt, as if you had typed it. The session appears on the
        board like any other. Schedules run only while ShellYard is running on this computer.
      </p>
      <div className="view-tools">
        <button type="button" className="primary" onClick={() => setDialog({})}>
          New schedule
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {schedules.length === 0 && <p className="empty">No schedules yet. Create one to have a prompt run by itself.</p>}
      {schedules.length > 0 && (
        <ul className="schedule-list">
          {schedules.map((s) => {
            const last = s.runs[0];
            const area = stories.find((x) => x.id === s.storyId);
            const profile = meta.profiles.find((p) => p.id === s.profileId);
            const lastSession = last?.sessionId ? sessions.find((x) => x.id === last.sessionId) : undefined;
            const lastResult = last ? runResult(last, now) : null;
            return (
              <li key={s.id} className={[s.enabled ? 'schedule' : 'schedule paused', lastResult?.needsYou ? 'needs-you' : ''].filter(Boolean).join(' ')}>
                <div className="schedule-main">
                  <div className="schedule-text">
                    <strong>{s.name}</strong>
                    <span className="schedule-when-text">{describeWhen(s.when)}</span>
                    <span className="hint">
                      {[profile ? profile.name : 'Launcher missing', s.model, area ? `in ${area.name}` : null].filter(Boolean).join(', ')}
                    </span>
                    <span className="schedule-prompt">{s.prompt}</span>
                  </div>
                  <dl className="schedule-facts">
                    <div>
                      <dt>Next run</dt>
                      <dd>{nextText(s, now)}</dd>
                    </div>
                    <div>
                      <dt>Last run</dt>
                      <dd>
                        {last ? (
                          <>
                            <span className={outcomeTone(last.outcome)}>{outcomeText(last.outcome)}</span>
                            <span className="hint"> {now - last.at < 60_000 ? 'just now' : `${durationLabel(now - last.at)} ago`}</span>
                            {lastResult?.text && <span className={`schedule-result ${lastResult.tone}`}>{lastResult.text}</span>}
                          </>
                        ) : (
                          <span className="hint">Never</span>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div className="schedule-actions">
                    <label className="check" title={s.enabled ? 'Pause this schedule' : 'Resume this schedule'}>
                      <input type="checkbox" checked={s.enabled} aria-label={`${s.name} is on`} onChange={(e) => act(api.updateSchedule(s.id, { enabled: e.target.checked }))} />
                      <span>On</span>
                    </label>
                    <button type="button" onClick={() => runNow(s)}>
                      Run now
                    </button>
                    {lastSession && (
                      <button type="button" onClick={() => setView({ kind: 'single', id: lastSession.id })}>
                        Show session
                      </button>
                    )}
                    <button type="button" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                      History
                    </button>
                    <button type="button" className="icon" title="Edit this schedule" aria-label={`Edit the schedule ${s.name}`} onClick={() => setDialog({ schedule: s })}>
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon"
                      title="Delete this schedule"
                      aria-label={`Delete the schedule ${s.name}`}
                      onClick={() => window.confirm(`Delete the schedule "${s.name}"? Sessions it started stay open.`) && act(api.deleteSchedule(s.id))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {open === s.id && (
                  <div className="schedule-history">
                    {s.runs.length === 0 && <p className="hint">It has not run yet.</p>}
                    {s.runs.length > 0 && (
                      <table>
                        <tbody>
                          {s.runs.map((r, i) => (
                            <tr key={`${r.at}-${i}`}>
                              <td>{whenLabel(r.at)}</td>
                              <td className={outcomeTone(r.outcome)}>{outcomeText(r.outcome)}</td>
                              <td className={runResult(r, now).tone}>{runResult(r, now).text}</td>
                              <td className="hint">{[r.manual ? 'Run by hand.' : null, r.detail].filter(Boolean).join(' ')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dialog && <ScheduleDialog schedule={dialog.schedule} onClose={() => setDialog(null)} />}
    </div>
  );
}
