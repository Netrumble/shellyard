import { useEffect, useState } from 'react';
import { titleFor } from './attention.js';
import { AttentionPanel } from './components/AttentionPanel.js';
import { BoardView } from './components/BoardView.js';
import { Cluster } from './components/Cluster.js';
import { ConversationsView } from './components/ConversationsView.js';
import { SchedulesView } from './components/SchedulesView.js';
import { UsageView } from './components/UsageView.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { Sidebar } from './components/Sidebar.js';
import { SingleTerminal, TerminalsGrid } from './components/TerminalsGrid.js';
import { selectCounts } from './selectors.js';
import { useStore } from './store.js';

export function App(): React.JSX.Element {
  const { sessions, stories, view, connection } = useStore();
  const [dialog, setDialog] = useState<{ storyId?: string } | null>(null);
  const filter = view.kind === 'attention' || view.kind === 'grid' ? view.storyFilter : undefined;
  const filterName = filter === undefined ? '' : filter === null ? 'No area' : (stories.find((s) => s.id === filter)?.name ?? '');
  const heading = view.kind === 'board' ? 'Board' : view.kind === 'attention' ? 'Needs attention' : view.kind === 'usage' ? 'Usage' : view.kind === 'conversations' ? 'Conversations' : view.kind === 'schedules' ? 'Schedules' : 'Terminals';
  const counts = selectCounts(sessions);

  useEffect(() => {
    document.title = titleFor(counts.attention);
  }, [counts.attention]);

  if (connection === 'unauthorized') {
    return (
      <main className="down">
        <h1>Open ShellYard from a terminal</h1>
        <p>
          Run <code>shellyard</code> in a terminal: it opens this page with the access it needs.
        </p>
      </main>
    );
  }

  if (connection === 'down') {
    return (
      <main className="down">
        <h1>ShellYard is not running</h1>
        <p>
          Run <code>shellyard</code> in a terminal to start it. This page reconnects by itself.
        </p>
      </main>
    );
  }

  return (
    <div className="app">
      <Sidebar onNewSession={(storyId) => setDialog({ storyId })} />
      <main className="main">
        <header className="topbar">
          <h1>
            {heading}
            {filterName && <span className="heading-filter">, {filterName}</span>}
          </h1>
          <Cluster />
          <dl className="counts">
            <div className={counts.attention > 0 ? 'count-item warn' : 'count-item'}>
              <dt>Needs attention</dt>
              <dd>{counts.attention}</dd>
            </div>
            <div className="count-item">
              <dt>Working</dt>
              <dd>{counts.working}</dd>
            </div>
            <div className="count-item">
              <dt>Idle</dt>
              <dd>{counts.idle}</dd>
            </div>
          </dl>
        </header>
        {connection !== 'open' && (
          <div className="banner" role="status">
            {connection === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
          </div>
        )}
        <div className="content">
          {view.kind === 'board' && <BoardView onNewSession={(storyId) => setDialog({ storyId })} />}
          {view.kind === 'attention' && <AttentionPanel storyFilter={view.storyFilter} />}
          {view.kind === 'grid' && <TerminalsGrid storyFilter={view.storyFilter} />}
          {view.kind === 'usage' && <UsageView />}
          {view.kind === 'conversations' && <ConversationsView />}
          {view.kind === 'schedules' && <SchedulesView />}
          {view.kind === 'single' && <SingleTerminal key={view.id} id={view.id} />}
        </div>
      </main>
      {dialog && <NewSessionDialog initialStoryId={dialog.storyId} onClose={() => setDialog(null)} />}
    </div>
  );
}
