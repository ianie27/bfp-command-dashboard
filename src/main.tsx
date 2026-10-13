// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles/global.scss';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

// Prevent flash-of-white between HTML load and React hydration
document.documentElement.style.background = '#0d0d1a';
document.body.style.background = '#0d0d1a';
document.body.style.margin = '0';
rootElement.style.background = '#0d0d1a';
rootElement.style.minHeight = '100vh';

createRoot(rootElement).render(
  <StrictMode>
    {/* Single top-level ErrorBoundary.
        Do NOT add a second one inside App.tsx — nested boundaries
        swallow errors that should bubble up to this one. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);