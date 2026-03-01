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
    },
  },
  optimizeDeps: {
    exclude: ['pmtiles'],
  },
})
