/**
 * Vercel Edge Function — NYC 311 recent complaints proxy
 * Socrata's $where syntax doesn't survive Vercel's rewrite layer cleanly.
 * This function fetches directly server-side and returns clean JSON.
 *
 * GET /api/nyc311
 * Returns last 48h of geolocated 311 complaints (max 500)
 */

export const config = { runtime: 'edge' };

export default async function handler() {
  try {
    // 311 data lags ~26h, so use 48h window to ensure we always have results
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19); // 'YYYY-MM-DDTHH:MM:SS' — Socrata rejects Z suffix

    const params = new URLSearchParams({
      '$where': `created_date>'${since}' AND latitude IS NOT NULL`,
      '$limit': '500',
      '$order': 'created_date DESC',
      '$select': 'unique_key,complaint_type,created_date,latitude,longitude',
    });

    const url = `https://data.cityofnewyork.us/resource/erm2-nwe9.json?${params}`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Socrata ${res.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await res.text();

    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // cache 5 min — 311 doesn't update faster
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
