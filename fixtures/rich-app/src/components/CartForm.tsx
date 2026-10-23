import { createOrder } from '@/api/client';
import { Button } from './ui/Button';

export function CartForm() {
  return (
    <form onSubmit={() => createOrder(['sku-1'])}>
      <Button>Pay</Button>
    </form>
  );
}
