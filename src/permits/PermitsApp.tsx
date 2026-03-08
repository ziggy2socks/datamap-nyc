/**
 * PermitsApp — entry point for /permits route in datamap.nyc
 * Wraps the full Permit Pulse app (AppShell + PermitContext)
 */
import { PermitProvider } from './PermitContext';
import AppShell from './AppShell';
import './App.css';
import './index.css';

export default function PermitsApp() {
  return (
    <PermitProvider>
      <AppShell />
    </PermitProvider>
  );
}
