export type OrderProps = { orderId: string };

export function OrderConfirmation({ orderId }: OrderProps) {
  return <p>Thanks! Your order {orderId} is on its way.</p>;
}
