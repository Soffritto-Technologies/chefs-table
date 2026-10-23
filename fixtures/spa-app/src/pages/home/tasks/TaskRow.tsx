import { useTaskStore } from '@/stores/useTaskStore';

export function TaskRow({ task }: { task: { id: string; title: string; done: boolean } }) {
  const toggle = useTaskStore((state) => state.toggle);

  return (
    <label>
      <input type="checkbox" checked={task.done} onChange={() => toggle(task.id)} />
      {task.title}
    </label>
  );
}
