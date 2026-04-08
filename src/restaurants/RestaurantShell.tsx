import { useState } from 'react';
import { useRestaurants } from './RestaurantContext';
import RestaurantSidebar from './RestaurantSidebar';
import RestaurantMap from './RestaurantMap';
import RestaurantCharts from './RestaurantCharts';
import './RestaurantApp.css';

export default function RestaurantShell() {
  const { view } = useRestaurants();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="rest-shell">
      <RestaurantSidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      {mobileOpen && <div className="rest-mobile-backdrop" onClick={() => setMobileOpen(false)} />}
      <button className="rest-mobile-fab" onClick={() => setMobileOpen(v => !v)}>
        {mobileOpen ? '✕' : '☰'}
      </button>
      <div className="rest-view">
        {view === 'charts' ? <RestaurantCharts /> : <RestaurantMap />}
      </div>
    </div>
  );
}
