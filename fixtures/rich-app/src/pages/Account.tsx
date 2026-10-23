import { Button } from '../components/ui/Button';
import { ProtectedRoute } from '@/auth/ProtectedRoute';

export function Account() {
  return (
    <ProtectedRoute>
      <a href="/account/settings">
        <Button>Settings</Button>
      </a>
    </ProtectedRoute>
  );
}
