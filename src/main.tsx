import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const path = window.location.pathname;

async function render() {
  let Component: React.ComponentType;

  if (path.startsWith('/311')) {
    const mod = await import('./radar/RadarApp');
    Component = mod.default;
  } else if (path.startsWith('/suitability')) {
    const mod = await import('./App');
    Component = mod.default;
  } else if (path.startsWith('/permits')) {
    const mod = await import('./PermitMap');
    Component = mod.default;
  } else {
    const mod = await import('./Landing');
    Component = mod.default;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Component />
    </StrictMode>,
  );
}

render();
