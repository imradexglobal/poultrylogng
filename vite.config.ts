import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  build: {
    // Increase warning limit to avoid noisy alerts for large bundles
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Split heavy dependencies into a separate vendor chunk
        manualChunks: {
          vendor: [
            'react',
            'react-dom',
            'dexie',
            'chart.js',
            'react-chartjs-2',
            // Add other large libs if needed
          ],
        },
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    host: true,
  },
})
