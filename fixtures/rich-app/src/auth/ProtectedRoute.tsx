import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';

export function ProtectedRoute({ children }: { children: unknown }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/login" />;
}
