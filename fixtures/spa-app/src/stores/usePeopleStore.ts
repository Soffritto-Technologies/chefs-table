type Person = { id: string; name: string; lastSeen: string };
type PeopleState = { people: Person[]; remove: (id: string) => void };

export const usePeopleStore = <T>(select: (state: PeopleState) => T): T => select({ people: [], remove: () => {} });
