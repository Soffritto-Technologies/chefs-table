type Router = { get(path: string, handler: () => unknown): void };

export function usersRoutes(router: Router) {
  router.get('/api/users', () => []);
}
