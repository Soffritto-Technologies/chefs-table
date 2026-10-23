import { createBrowserRouter } from 'react-router-dom';
import { Home } from './pages/Home';
import { Shop } from './pages/Shop';
import { Product } from './pages/Product';
import { Checkout } from './pages/Checkout';
import { Account } from './pages/Account';
import { AccountSettings } from './pages/AccountSettings';
import { Login } from '@/pages/Login';

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/shop', element: <Shop /> },
  { path: '/shop/:id', element: <Product /> },
  { path: '/checkout', element: <Checkout /> },
  { path: '/account', element: <Account /> },
  { path: '/account/settings', element: <AccountSettings /> },
  { path: '/login', Component: Login },
]);
