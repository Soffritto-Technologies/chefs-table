import { createBrowserRouter } from 'react-router-dom';
import { HomePage } from './pages/home/HomePage';

export const router = createBrowserRouter([{ path: '/home', element: <HomePage /> }]);
