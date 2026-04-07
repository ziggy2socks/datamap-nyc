import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { Crash, SeverityFilter, ModeFilter } from './types';
import { fetchCrashes, ALL_BOROUGHS } from './crash-data';

export type CrashView = 'map' | 'charts';

export interface CrashFilters {
  dateFrom: string;
  dateTo:   string;
  severity: SeverityFilter;
  mode:     ModeFilter;
  boroughs: Set<string>;
}

export interface CrashContextValue {
  view:    CrashView;
  setView: (v: CrashView) => void;

  crashes:      Crash[];
  loading:      boolean;
  error:        string | null;
  totalFetched: number;
  reload:       () => void;

  filters:       CrashFilters;
  setDateFrom:   (d: string) => void;
  setDateTo:     (d: string) => void;
  setSeverity:   (s: SeverityFilter) => void;
  setMode:       (m: ModeFilter) => void;
  toggleBorough: (b: string) => void;

  selected:    Crash | null;
  setSelected: (c: Crash | null) => void;
}

const MAP_LIMIT = 50_000;
export const MIN_DATE = '2013-07-01';

function todayStr() { return new Date().toISOString().split('T')[0]; }
function daysAgoStr(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

const CrashContext = createContext<CrashContextValue | null>(null);

export function CrashProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<CrashView>('map');

  const [dateFrom, setDateFrom] = useState(daysAgoStr(30));
  const [dateTo,   setDateTo]   = useState(todayStr());
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [mode,     setMode]     = useState<ModeFilter>('all');
  const [boroughs, setBoroughs] = useState<Set<string>>(new Set(ALL_BOROUGHS));

  const [crashes,      setCrashes]      = useState<Crash[]>([]);
  const [totalFetched, setTotalFetched] = useState(0);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const fetchKey = useRef(0);

  const load = useCallback(async () => {
    const key = ++fetchKey.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCrashes(dateFrom, dateTo, MAP_LIMIT, severity, mode, boroughs);
      if (key !== fetchKey.current) return;
      setCrashes(data);
      setTotalFetched(data.length);
    } catch (e) {
      if (key !== fetchKey.current) return;
      setError((e as Error).message);
    } finally {
      if (key === fetchKey.current) setLoading(false);
    }
  }, [dateFrom, dateTo, severity, mode, boroughs]);

  // Debounce 600ms
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(load, 600);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [load]);

  const toggleBorough = useCallback((b: string) => {
    setBoroughs(prev => { const n = new Set(prev); n.has(b) ? n.delete(b) : n.add(b); return n; });
  }, []);

  const [selected, setSelected] = useState<Crash | null>(null);

  const filters: CrashFilters = { dateFrom, dateTo, severity, mode, boroughs };

  return (
    <CrashContext.Provider value={{
      view, setView,
      crashes, loading, error, totalFetched, reload: load,
      filters,
      setDateFrom, setDateTo, setSeverity, setMode, toggleBorough,
      selected, setSelected,
    }}>
      {children}
    </CrashContext.Provider>
  );
}

export function useCrashes() {
  const ctx = useContext(CrashContext);
  if (!ctx) throw new Error('useCrashes must be used inside CrashProvider');
  return ctx;
}
