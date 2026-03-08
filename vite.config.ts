import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5178,
    proxy: {
      '/api/geocode': {
        target: 'https://geosearch.planninglabs.nyc',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/geocode/, '/v2/autocomplete'),
      },
      '/api/permits': {
        target: 'https://data.cityofnewyork.us/resource',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/permits/, '/rbx6-tga4.json'),
      },
      '/api/jobs': {
        target: 'https://data.cityofnewyork.us/resource',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/jobs/, '/w9ak-ipjd.json'),
      },
      '/api/311': {
        target: 'https://data.cityofnewyork.us/resource',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/311/, '/erm2-nwe9.json'),
      },
      '/dzi': {
        target: 'https://isometric-nyc-tiles.cannoneyed.com',
        changeOrigin: true,
      },
      '/api/adsb': {
        target: 'https://api.adsb.lol/v2',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/adsb/, ''),
      },
    },
  },
  optimizeDeps: {
    exclude: ['pmtiles'],
  },
})
