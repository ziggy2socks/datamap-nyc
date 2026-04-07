import { useState } from 'react';
import { useCrashes } from './CrashContext';
import CrashSidebar from './CrashSidebar';
import CrashMap from './CrashMap';
import CrashCharts from './CrashCharts';
import './CrashApp.css';

export default function CrashShell() {
  const { view } = useCrashes();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="crash-shell">
      <CrashSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      {mobileOpen && <div className="crash-mobile-backdrop" onClick={() => setMobileOpen(false)} />}
      <button className="crash-mobile-fab" onClick={() => setMobileOpen(v => !v)}>
        {mobileOpen ? '✕' : '☰'}
      </button>
      <div className="crash-view">
        {view === 'charts' ? <CrashCharts /> : <CrashMap />}
      </div>
    </div>
  );
}
