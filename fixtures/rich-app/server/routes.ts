import type { OrderProps } from '../emails/OrderConfirmation';

type Response = { json(body: unknown): void; status(code: number): Response };
type Handler = (req: { body: OrderProps }, res: Response) => unknown;
type Router = { get(path: string, handler: Handler): void; post(path: string, handler: Handler): void };

export function registerRoutes(router: Router) {
  router.get('/api/products', (_req, res) => res.json([]));

  router.post('/api/orders', async (req, res) => {
    await sendEmail(req.body);
    res.status(201).json({ ok: true });
  });
}

function sendEmail(_order: OrderProps) {
  return Promise.resolve();
}
