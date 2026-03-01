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

export const LAYERS: Layer[] = [
  {
    id: 'park_score',
    label: 'Park Access',
    description: 'Total open space acreage weighted by distance — gravity model. Higher = more accessible public space.',
    property: 'park_score',
    type: 'continuous',
    colorScale: ['#F0EDE6', '#A8CCA8', '#4A8A4A', '#2D6E2D'],
    accentColor: '#4A8A4A',
    enabled: true,
    opacity: 0.65,
  },
  {
    id: 'numfloors',
    label: 'Building Height',
    description: 'Number of floors above grade.',
    property: 'numfloors',
    type: 'continuous',
    colorScale: ['#F0EDE6', '#A8BED4', '#4A7AAA', '#1A4A7A'],
    accentColor: '#4A7AAA',
    enabled: false,
    opacity: 0.65,
  },
  {
    id: 'landuse',
    label: 'Land Use',
    description: 'NYC DCP land use classification.',
    property: 'landuse',
    type: 'categorical',
    colorScale: Object.values(LAND_USE_COLORS),
    accentColor: '#9B8EC4',
    categories: LAND_USE_LABELS,
    enabled: false,
    opacity: 0.65,
  },
];
