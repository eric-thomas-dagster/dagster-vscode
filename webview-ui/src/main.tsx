import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initVsCodeThemeSync } from './vscodeTheme';
import './index.css';

initVsCodeThemeSync();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
