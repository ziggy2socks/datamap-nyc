import type { Layer } from './types';

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
  '01': '#f4a460',
  '02': '#ffa500',
  '03': '#ff6347',
  '04': '#ff4500',
  '05': '#c71585',
  '06': '#9370db',
  '07': '#4169e1',
  '08': '#20b2aa',
  '09': '#228b22',
  '10': '#808080',
  '11': '#d3d3d3',
};

export const LAYERS: Layer[] = [
  {
    id: 'park_score',
    label: 'Park Access',
    description: 'Total open space acreage weighted by distance — gravity model. Higher = more accessible public space.',
    property: 'park_score',
    type: 'continuous',
    colorScale: ['#0a0c14', '#1a4a1a', '#2d7a2d', '#52c452', '#88ff88'],
    enabled: true,
    opacity: 0.75,
  },
  {
    id: 'numfloors',
    label: 'Building Height',
    description: 'Number of floors above grade.',
    property: 'numfloors',
    type: 'continuous',
    colorScale: ['#0a0c14', '#1a2a4a', '#2244aa', '#4488ff', '#aaddff'],
    enabled: false,
    opacity: 0.75,
  },
  {
    id: 'landuse',
    label: 'Land Use',
    description: 'NYC DCP land use classification.',
    property: 'landuse',
    type: 'categorical',
    colorScale: Object.values(LAND_USE_COLORS),
    categories: LAND_USE_LABELS,
    enabled: false,
    opacity: 0.75,
  },
];
