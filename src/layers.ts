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
        description: 'Gravity score: cumulative access to open space within 1 mile, percentile-ranked across 849k parcels.',
        info: {
          what: 'How well-connected each parcel is to NYC\'s parks and open spaces, scored as a percentile rank from 0–100.',
          how: 'A gravity model sums up access to every open space within 1 mile, weighted by park acreage and penalized by distance. Larger, closer parks contribute more. Distance is measured to the nearest edge of each park polygon — not its center — so a parcel on the edge of Central Park scores the same as one inside it. The raw gravity value is then percentile-ranked: a score of 72 means this parcel has better park access than 72% of all NYC parcels.',
          formula: 'score = Σ (acres_i) / (dist_edge_i + 50)²',
          source: 'NYC Parks Dept. Open Space GIS (2024). Park polygon boundaries via NYC Open Data. Scored across 849,801 parcels from NYC MapPLUTO 24v2.',
          caveats: 'Open space parcels (parks themselves) are excluded from ranking and shown as transparent. Score reflects proximity to all open space types — passive parks, playgrounds, greenways, and plazas. Does not distinguish park quality, programming, or amenities.',
        },
        property: 'park_score',
        type: 'continuous',
        colorScale: ['#F0EDE6', '#A8CCA8', '#4A8A4A', '#2D6E2D'],
        accentColor: '#4A8A4A',
        enabled: false,
        opacity: 0.75,
      },
      {
        id: 'flood_100yr',
        label: '100-Year Floodplain',
        description: 'FEMA 1% annual chance flood zone. Parcels inside face a 26% cumulative flood probability over a 30-year mortgage.',
        info: {
          what: 'Parcels that fall within FEMA\'s 100-year flood zone — areas with a 1% annual probability of flooding from coastal storm surge or riverine flooding.',
          how: 'Binary flag: 1 = parcel centroid lies within the FEMA Special Flood Hazard Area (SFHA), Zone AE or VE. A "1% annual chance" flood means there is a 26% cumulative probability of at least one flood event over a 30-year period — the typical length of a mortgage.',
          source: 'FEMA National Flood Hazard Layer (NFHL), effective 2020. NYC counties: New York (36061), Kings (36047), Queens (36081), Bronx (36005), Richmond (36085). Accessed via NYC DEP / NYC Open Data.',
          caveats: 'FEMA maps are updated periodically and may not reflect recent shoreline changes or current storm surge models. NYC\'s own climate projections (e.g., NYC Panel on Climate Change) suggest substantially larger future flood zones by 2050–2100. Does not include Sandy-era inundation extent.',
        },
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
        description: 'NYC DEP moderate stormwater flood risk — areas that flood during heavy rain events (~2 in/hr), distinct from coastal surge.',
        info: {
          what: 'Areas at risk of street and property flooding during intense rainfall events, independent of coastal storm surge or sea level rise.',
          how: 'Binary flag: 1 = parcel centroid falls within the NYC DEP "moderate" stormwater flood risk area. These are low-lying areas that collect runoff when the sewer system is overwhelmed during heavy rain (~2 inches/hour or more). This is street flooding, not coastal inundation.',
          source: 'NYC DEP Stormwater Flood Maps (2022), published via NYC Open Data. Modeled at current sea level. Separate from FEMA coastal flood zones.',
          caveats: 'Moderate risk is the middle tier (three tiers: moderate, high, nuisance). Does not reflect future climate scenarios. Many red-lined areas on this map overlap with low-income neighborhoods — this is a known environmental justice issue in NYC.',
        },
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
        description: 'Floors above grade per MapPLUTO. Reveals NYC\'s density gradient from Manhattan towers to outer-borough rowhouses.',
        info: {
          what: 'The number of above-grade floors in the building on each parcel, as reported by NYC Department of City Planning.',
          how: 'Raw floor count from MapPLUTO. Parcels with no building (vacant land, parking, open space) show 0 floors. The color ramp runs from neutral gray (0–1 floors) to deep slate blue (60+ floors). NYC\'s tallest building is 111 West 57th St at 93 floors (432 Park Avenue records 104 but MapPLUTO uses a different methodology).',
          source: 'NYC MapPLUTO 24v2, NYC Department of City Planning. Released under CC BY 4.0. Updated annually.',
          caveats: 'Floor counts in MapPLUTO can lag real construction by 1–3 years. Converted industrial buildings and lofts may show inaccurate floor counts. Does not capture mezzanines, mechanical floors, or below-grade levels.',
        },
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
        description: 'Year of original construction. Darker = older. Reveals NYC\'s building eras from tenement blocks to contemporary towers.',
        info: {
          what: 'The year the primary building on each parcel was originally constructed, as recorded in NYC property records.',
          how: 'Raw year from MapPLUTO. Color runs from dark brown (pre-1900) to neutral warm gray (post-2000). NYC\'s building stock layers visibly by era: pre-1900 tenement blocks in Lower East Side and Harlem; 1900–1940 pre-war elevator buildings along transit corridors; 1940–1970 postwar public housing and suburban expansion; 1970–2000 relative stagnation; 2000+ luxury and mixed-use in redeveloped areas.',
          source: 'NYC MapPLUTO 24v2, NYC Department of City Planning. Year built from Department of Finance property records.',
          caveats: 'Gut-renovated buildings may still reflect original construction year. Parcels with multiple buildings show the year of the primary structure. Year = 0 means no year on record — shown as neutral. Historic preservation and landmark status are not reflected here.',
        },
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
        description: 'Residential units per 1,000 sq ft of lot area. High = dense apartment buildings; low = detached homes or non-residential uses.',
        info: {
          what: 'A measure of how densely residential each parcel is — the number of housing units packed into each 1,000 square feet of lot area.',
          how: 'Calculated as: (residential units × 1,000) ÷ lot area in sq ft. A single-family home on a 5,000 sf lot = 0.2 units/ksf. A 200-unit apartment on a 20,000 sf lot = 10 units/ksf. Zero means no residential units recorded (commercial, industrial, vacant, etc.).',
          formula: 'density = (unitsres × 1000) / lotarea',
          source: 'NYC MapPLUTO 24v2, NYC Department of City Planning. Unit counts from Department of Buildings records and Department of Finance.',
          caveats: 'Illegal or undocumented units are not reflected. Newly completed buildings may not yet have final unit counts. Very small lot areas can produce extreme outliers. Does not capture building occupancy or vacancy rates.',
        },
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
    id: 'education',
    label: 'Education',
    layers: [
      {
        id: 'school_zones',
        label: 'School Zones',
        description: 'NYC DOE attendance zones colored by ELA proficiency (1.0–4.0 scale). Elementary default. HS zones cover only ~80 geographically zoned schools.',
        info: {
          what: 'The public school attendance zone your address falls within — and how that school performs on state ELA (English Language Arts) assessments.',
          how: 'Each zone polygon represents the catchment area for a single NYC public school. Color reflects that school\'s average ELA proficiency score on a 1.0–4.0 scale from the NYC DOE School Quality Report: 1.0 = well below grade level, 2.0 = approaching, 3.0 = at grade level, 4.0 = above grade level. City average is ~2.9. Score is percentile-ranked against all NYC schools.',
          source: 'School zone polygons: NYC Open Data, NYC Dept. of Education, 2024–25 school year (datasets cmjf-yawu, t26j-jbq7, ruu9-egea). Quality scores: NYC DOE School Quality Reports 2024, NYC Open Data dataset dnpx-dfnc.',
          caveats: 'NYC high schools operate primarily as a choice system — most students apply to schools citywide regardless of zone, so high school zones are largely symbolic. Only ~32 of 80 high school zones have quality data. Scores reflect 2022–23 school year performance (most recent available as of 2024). ELA scores compare students to peer groups, not absolute benchmarks. Scores do not capture after-school programming, art, sports, or community.',
        },
        property: 'park_score' as keyof import('./types').ParcelProperties, // placeholder; school_zones layer uses its own GeoJSON source
        type: 'continuous',
        colorScale: ['#F5F0E8', '#C8DDB8', '#7AB87A', '#2D7A2D'],
        accentColor: '#7AB87A',
        enabled: false,
        opacity: 0.65,
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
        description: 'NYC DCP land use classification — 11 categories from single-family residential to open space. Source: MapPLUTO 24v2.',
        info: {
          what: 'How each parcel is officially classified by NYC Department of City Planning — what the land is used for, not what the building looks like.',
          how: 'MapPLUTO assigns each parcel one of 11 land use categories based on the building class and use recorded in Department of Finance records. Categories reflect primary use; a building with retail on ground floor and apartments above is classified by its dominant use.',
          source: 'NYC MapPLUTO 24v2, NYC Department of City Planning. Released under CC BY 4.0. LandUse codes documented at: nyc.gov/site/planning/data-maps/open-data/pluto-data-dictionary.page',
          caveats: 'Land use reflects official records, not always current reality. Vacant land (11) includes long-undeveloped lots awaiting redevelopment. Public facilities (08) includes schools, hospitals, government buildings, and houses of worship. Mixed-use buildings are classified by primary use only.',
        },
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
