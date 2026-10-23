import { PersonCard } from './PersonCard';
import { usePeopleStore } from '@/stores/usePeopleStore';
import { useSession } from '@/hooks/useSession';

export function PeopleView() {
  const people = usePeopleStore((state) => state.people);
  const session = useSession();

  if (!session.signedIn) return <p>Sign in to see your people.</p>;
  if (people.length === 0) return <p>Nobody here yet. Add your first contact.</p>;

  return (
    <section>
      {people.map((person) => (
        <PersonCard key={person.id} person={person} />
      ))}
    </section>
  );
}
