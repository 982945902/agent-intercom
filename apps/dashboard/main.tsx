import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './dashboard.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
