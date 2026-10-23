import { Button } from '@/components/ui';
import { CartForm } from '../components/CartForm';

export function Checkout() {
  return (
    <main>
      <CartForm />
      <Button>Back</Button>
    </main>
  );
}
