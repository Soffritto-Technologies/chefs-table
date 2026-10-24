export function Pricing() {
  return <form onSubmit={() => fetch('/api/subscribe', { method: 'POST' })}>Subscribe</form>;
}
