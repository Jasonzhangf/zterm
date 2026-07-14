import React from 'react';
import ReactDOM from 'react-dom/client';
import { WindowsDesktopApp } from './WindowsDesktopApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><WindowsDesktopApp /></React.StrictMode>,
);
