import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { Restaurant, GradeFilter } from './types';
import { fetchRestaurants, ALL_BOROUGHS } from './restaurant-data';

export type RestaurantView = 'map' | 'charts';

export interface RestaurantFilters {
  grade:    GradeFilter;
  boroughs: Set<string>;
  cuisine:  string;
}

export interface RestaurantContextValue {
  view:    RestaurantView;
  setView: (v: RestaurantView) => void;

  restaurants:  Restaurant[];
  loading:      boolean;
  error:        string | null;
  totalFetched: number;
  reload:       () => void;

  filters:       RestaurantFilters;
  setGrade:      (g: GradeFilter) => void;
  toggleBorough: (b: string) => void;
  setCuisine:    (c: string) => void;

  selected:    Restaurant | null;
  setSelected: (r: Restaurant | null) => void;
}

const RestaurantContext = createContext<RestaurantContextValue | null>(null);

export function RestaurantProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<RestaurantView>('map');

  const [grade,    setGrade]    = useState<GradeFilter>('all');
  const [boroughs, setBoroughs] = useState<Set<string>>(new Set(ALL_BOROUGHS));
  const [cuisine,  setCuisine]  = useState('');

  const [restaurants,  setRestaurants]  = useState<Restaurant[]>([]);
  const [totalFetched, setTotalFetched] = useState(0);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const fetchKey = useRef(0);

  const load = useCallback(async () => {
    const key = ++fetchKey.current;
    setLoading(true); setError(null);
    try {
      const data = await fetchRestaurants(20000, grade, boroughs, cuisine || undefined);
      if (key !== fetchKey.current) return;
      setRestaurants(data);
      setTotalFetched(data.length);
    } catch (e) {
      if (key !== fetchKey.current) return;
      setError((e as Error).message);
    } finally {
      if (key === fetchKey.current) setLoading(false);
    }
  }, [grade, boroughs, cuisine]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(load, 600);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [load]);

  const toggleBorough = useCallback((b: string) => {
    setBoroughs(prev => { const n = new Set(prev); n.has(b) ? n.delete(b) : n.add(b); return n; });
  }, []);

  const [selected, setSelected] = useState<Restaurant | null>(null);

  const filters: RestaurantFilters = { grade, boroughs, cuisine };

  return (
    <RestaurantContext.Provider value={{
      view, setView,
      restaurants, loading, error, totalFetched, reload: load,
      filters, setGrade, toggleBorough, setCuisine,
      selected, setSelected,
    }}>
      {children}
    </RestaurantContext.Provider>
  );
}

export function useRestaurants() {
  const ctx = useContext(RestaurantContext);
  if (!ctx) throw new Error('useRestaurants must be used inside RestaurantProvider');
  return ctx;
}
