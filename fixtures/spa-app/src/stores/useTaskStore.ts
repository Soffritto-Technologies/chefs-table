type Task = { id: string; title: string; done: boolean };
type TaskState = { tasks: Task[]; toggle: (id: string) => void };

export const useTaskStore = <T>(select: (state: TaskState) => T): T => select({ tasks: [], toggle: () => {} });
