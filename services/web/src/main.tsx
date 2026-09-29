import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/cyrillic-400.css';
import '@fontsource/inter/cyrillic-500.css';
import '@fontsource/inter/cyrillic-600.css';
import '@fontsource/inter/cyrillic-700.css';
import './app/styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
