import type { Layer, LayerGroup } from './types';

export const LAND_USE_LABELS: Record<string, string> = {
  '01': 'One & Two Family',
  '02': 'Multi-Family Walkup',
  '03': 'Multi-Family Elevator',
  '04': 'Mixed Residential',
  '05': 'Commercial & Office',
  '06': 'Industrial',
  '07': 'Transportation',
  '08': 'Public Facilities',
  '09': 'Open Space',
  '10': 'Parking',
  '11': 'Vacant Land',
};

export const LAND_USE_COLORS: Record<string, string> = {
  '01': '#E8C4A0',
  '02': '#D4A882',
  '03': '#C08060',
  '04': '#A06040',
  '05': '#9B8EC4',
  '06': '#8080A0',
  '07': '#8AAAC0',
  '08': '#80B0A0',
  '09': '#80AA70',
  '10': '#C0BDB8',
  '11': '#E0DDD8',
};

// ── Layer definitions ────────────────────────────────────────

export const LAYER_GROUPS: LayerGroup[] = [
  {
    id: 'environment',
    label: 'Environment',
    layers: [
      {
        id: 'park_score',
        label: 'Park Access',
        description: 'Gravity-based score measuring cumulative access to all open spaces within 1 mile. Accounts for park size and distance — a small nearby park and a large distant park both contribute. Percentile rank across 849k NYC parcels (open space parcels excluded).',
        property: 'park_score',
        type: 'continuous',
        colorScale: ['#F0EDE6', '#A8CCA8', '#4A8A4A', '#2D6E2D'],
        accentColor: '#4A8A4A',
        enabled: true,
        opacity: 0.75,
      },
      {
        id: 'flood_100yr',
        label: '100-Year Floodplain',
        description: 'FEMA 1% annual chance flood zone (aka "100-year flood"). Parcels inside this boundary face a 26% cumulative probability of flooding over a 30-year mortgage. Source: NYC DEP / FEMA NFHL (2020). Binary: in zone or not.',
        property: 'flood_100yr',
        type: 'binary',
        colorScale: ['#F0EDE6', '#4A7AB0'],
        accentColor: '#4A7AB0',
        enabled: false,
        opacity: 0.75,
      },
      {
        id: 'flood_storm',
        label: 'Stormwater Flood Risk',
        description: 'NYC DEP moderate stormwater flooding at current sea level — areas prone to flooding during intense rain events (~2 in/hr). Distinct from coastal flooding. Source: NYC DEP Stormwater Flood Maps (2022). Binary: in zone or not.',
        property: 'flood_storm',
        type: 'binary',
        colorScale: ['#F0EDE6', '#7A4AB0'],
        accentColor: '#7A4AB0',
        enabled: false,
        opacity: 0.75,
      },
    ],
  },
  {
    id: 'built',
    label: 'Built Environment',
    layers: [
      {
        id: 'numfloors',
        label: 'Building Height',
        description: 'Number of floors above grade from MapPLUTO. Reveals NYC\'s density patterns — low-rise outer boroughs vs. Manhattan towers. Max recorded: 104 floors (One World Trade).',
        property: 'numfloors',
        type: 'continuous',
        colorScale: ['#F0EDE6', '#A8BED4', '#4A7AAA', '#1A4A7A'],
        accentColor: '#4A7AAA',
        enabled: false,
        opacity: 0.75,
      },
      {
        id: 'yearbuilt',
        label: 'Year Built',
        description: 'Year of original construction. NYC\'s building eras: pre-1900 (tenement era), 1900–1940 (pre-war boom), 1940–1970 (postwar expansion), 1970–2000 (stagnation + renewal), 2000+ (contemporary). Darker = older.',
        property: 'yearbuilt',
        type: 'continuous',
        colorScale: ['#F0EDE6', '#D4C4A0', '#A08040', '#604010'],
        accentColor: '#A08040',
        enabled: false,
        opacity: 0.75,
      },
      {
        id: 'density',
        label: 'Residential Density',
        description: 'Residential units per 1,000 sq ft of lot area. A proxy for housing density — high values indicate dense apartment buildings, low values indicate single-family homes or commercial uses.',
        property: 'density',
        type: 'continuous',
        colorScale: ['#F0EDE6', '#E0C4D0', '#B06080', '#6A1840'],
        accentColor: '#B06080',
        enabled: false,
        opacity: 0.75,
      },
    ],
  },
  {
    id: 'land',
    label: 'Land',
    layers: [
      {
        id: 'landuse',
        label: 'Land Use',
        description: 'NYC Department of City Planning land use classification. 11 categories covering residential, commercial, industrial, civic, and open space uses. Source: MapPLUTO 24v2.',
        property: 'landuse',
        type: 'categorical',
        colorScale: Object.values(LAND_USE_COLORS),
        accentColor: '#9B8EC4',
        categories: LAND_USE_LABELS,
        enabled: false,
        opacity: 0.75,
      },
    ],
  },
];

// Flat list for backwards compatibility
export const LAYERS: Layer[] = LAYER_GROUPS.flatMap(g => g.layers);
