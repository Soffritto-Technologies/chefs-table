import { usePeopleStore } from '@/stores/usePeopleStore';

export function PersonCard({ person }: { person: { id: string; name: string; lastSeen: string } }) {
  const remove = usePeopleStore((state) => state.remove);

  return (
    <article>
      <h3>{person.name}</h3>
      <p>Last spoke on {person.lastSeen}</p>
      <button onClick={() => remove(person.id)}>Remove</button>
    </article>
  );
}
