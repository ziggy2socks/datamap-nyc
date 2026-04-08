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
    const mod = await import('./App');           // McHarg suitability layer map
    Component = mod.default;
  } else if (path.startsWith('/permits')) {
    const mod = await import('./permits/PermitsApp');
    Component = mod.default;
  } else if (path.startsWith('/restaurants')) {
    const mod = await import('./restaurants/RestaurantsApp');
    Component = mod.default;
  } else if (path.startsWith('/crashes')) {
    const mod = await import('./crashes/CrashesApp');
    Component = mod.default;
  } else if (path.startsWith('/live')) {
    const mod = await import('./live/LiveApp');
    Component = mod.default;
  } else if (path.startsWith('/globe') || path.startsWith('/soil')) {
    const mod = await import('./globe/GlobeApp');
    Component = mod.default;
  } else {
    const mod = await import('./Landing');
    Component = mod.default;
  }

  // StrictMode intentionally disabled for Three.js routes — double-invoke tears down WebGL context
  const useStrict = !path.startsWith('/globe') && !path.startsWith('/soil');
  const el = <Component />;
  createRoot(document.getElementById('root')!).render(
    useStrict ? <StrictMode>{el}</StrictMode> : el
  );
}

render();
