import { createBrowserRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { Pricing } from './pages/Pricing';

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/pricing', element: <Pricing /> },
]);
