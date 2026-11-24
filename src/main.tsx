import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/tokens.css';
import './design/base.css';
import './design/primitives.css';
import { App } from './app/App';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
