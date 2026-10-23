import { Button } from '@/components/ui';
import { Nav } from '../components/Nav';
import { listProducts } from '../api/client';

export function Shop() {
  const products = listProducts();
  return (
    <main>
      <Nav />
      {products.map((p) => (
        <a href={`/shop/${p.id}`}>{p.name}</a>
      ))}
      <Button>Filter</Button>
    </main>
  );
}
