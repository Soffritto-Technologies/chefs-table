import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';

export function Login() {
  const navigate = useNavigate();
  return <Button onClick={() => navigate('/account')}>Sign in</Button>;
}
