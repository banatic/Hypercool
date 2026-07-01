import React from 'react';
import ReactDOM from 'react-dom/client';
import { DownloadPanel } from './download-panel/DownloadPanel';
import './download-panel/DownloadPanel.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DownloadPanel />
  </React.StrictMode>
);
