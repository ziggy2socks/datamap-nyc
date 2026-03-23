/**
 * Vercel API: /api/forecast-manifest
 * Returns the forecast manifest from Vercel Blob (or 404 if not baked yet).
 * Short cache so clients always get fresh manifest after nightly bake.
 */
import { head } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    // The manifest blob URL is deterministic — same path, overwritten nightly
    const blobStoreId = process.env.BLOB_READ_WRITE_TOKEN
      ? process.env.BLOB_READ_WRITE_TOKEN.split('_')[1]
      : null;

    if (!blobStoreId) {
      return res.status(503).json({ error: 'Blob storage not configured. Set BLOB_READ_WRITE_TOKEN env var.' });
    }

    // Fetch manifest from blob store
    const manifestUrl = `https://${blobStoreId}.public.blob.vercel-storage.com/forecast/manifest.json`;
    const r = await fetch(manifestUrl);
    if (!r.ok) {
      return res.status(404).json({
        error: 'Forecast not yet available. Nightly cron runs at 2am UTC.',
        hint: 'Trigger manually: GET /api/cron-forecast'
      });
    }
    const manifest = await r.json();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=7200');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
