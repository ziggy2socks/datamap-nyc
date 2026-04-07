import { CrashProvider } from './CrashContext';
import CrashShell from './CrashShell';

export default function CrashesApp() {
  return (
    <CrashProvider>
      <CrashShell />
    </CrashProvider>
  );
}
