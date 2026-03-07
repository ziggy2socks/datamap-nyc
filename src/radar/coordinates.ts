// Coordinate projection for NYC radar
// Projects lat/lon to canvas XY, auto-fitted to a circular viewport

// NYC bounding box (all 5 boroughs)
export const NYC_BOUNDS = {
  minLat: 40.477,
  maxLat: 40.920,
  minLon: -74.260,
  maxLon: -73.700,
};

// Center of the radar
export const CENTER_LAT = (NYC_BOUNDS.minLat + NYC_BOUNDS.maxLat) / 2;
export const CENTER_LON = (NYC_BOUNDS.minLon + NYC_BOUNDS.maxLon) / 2;

// Scale to fit NYC in ~115% of the radar circle radius (zoomed in ~30%, edges clip naturally)
// Lat span ~0.443°, Lon span ~0.560° (lon is wider due to map aspect)
// We scale to fit the wider dimension
export function makeProjection(canvasSize: number) {
  const R = canvasSize / 2;  // radar radius in pixels
  const usable = R * 1.15;   // 115% = zoomed in ~30%, outer boroughs clip at edges

  const latSpan = NYC_BOUNDS.maxLat - NYC_BOUNDS.minLat;
  const lonSpan = NYC_BOUNDS.maxLon - NYC_BOUNDS.minLon;

  // Correct lon for latitude compression
  const lonCorrected = lonSpan * Math.cos(CENTER_LAT * Math.PI / 180);

  // Scale: fit the larger span into usable radius
  const scale = usable / Math.max(latSpan / 2, lonCorrected / 2);

  return function latLonToXY(lat: number, lon: number): { x: number; y: number } {
    const cx = canvasSize / 2;
    const cy = canvasSize / 2;
    const dx = (lon - CENTER_LON) * Math.cos(CENTER_LAT * Math.PI / 180) * scale;
    const dy = -(lat - CENTER_LAT) * scale;
    return { x: cx + dx, y: cy + dy };
  };
}
