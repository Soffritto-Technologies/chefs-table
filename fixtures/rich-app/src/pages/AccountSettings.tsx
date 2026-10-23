import { Button } from '../components/ui/Button';
import { ProtectedRoute } from '../auth/ProtectedRoute';

export function AccountSettings() {
  return (
    <ProtectedRoute>
      <Button>Save</Button>
    </ProtectedRoute>
  );
}
