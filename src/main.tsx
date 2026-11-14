import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import { engine } from './engine/engine';
import * as store from './state/store';

// test/debug hook (used by the end-to-end tests)
(window as unknown as { __ars: unknown }).__ars = { engine, store };

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
