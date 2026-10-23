import { useState } from 'react';
import { PeopleView } from './people/PeopleView';
import { TasksView } from './tasks/TasksView';
import { NotebookView } from './notebook/NotebookView';
import { useAppStore } from '@/stores/useAppStore';
import { useSession } from '@/hooks/useSession';

type Tab = 'people' | 'tasks' | 'notebook';

export function HomePage() {
  const [tab, setTab] = useState<Tab>('people');
  const workspace = useAppStore((state) => state.workspace);
  const session = useSession();

  return (
    <main>
      <header>
        <h1>{workspace}</h1>
        <span>{session.userName}</span>
      </header>
      <nav>
        <button onClick={() => setTab('people')}>People</button>
        <button onClick={() => setTab('tasks')}>Tasks</button>
        <button onClick={() => setTab('notebook')}>Notebook</button>
      </nav>
      {tab === 'people' && <PeopleView />}
      {tab === 'tasks' && <TasksView />}
      {tab === 'notebook' && <NotebookView />}
    </main>
  );
}
