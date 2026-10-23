import { TaskRow } from './TaskRow';
import { useTaskStore } from '@/stores/useTaskStore';
import { useSession } from '@/hooks/useSession';

export function TasksView() {
  const tasks = useTaskStore((state) => state.tasks);
  const session = useSession();

  return (
    <section>
      <h2>{session.userName}'s tasks</h2>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </section>
  );
}
