import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the app under /ai-recording-studio/
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
