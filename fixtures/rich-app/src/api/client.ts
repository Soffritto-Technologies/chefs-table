export async function createOrder(items: string[]) {
  const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ items }) });
  return res.json();
}

export async function listProducts() {
  return fetch('/api/products').then((res) => res.json());
}
