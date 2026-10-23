export function Button({ children, onClick }: { children: unknown; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  );
}
