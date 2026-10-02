import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode demo` produces one self-contained HTML file with baked-in
// data (see scripts/build-demo.mjs) that can be opened without the backend.
const stripTelegramSdk: Plugin = {
  name: 'strip-telegram-sdk',
  transformIndexHtml: (html) => html.replace(/\s*<script src="https:\/\/telegram\.org[^>]*><\/script>/, ''),
};

export default defineConfig(({ mode }) => ({
  plugins: mode === 'demo' ? [react(), stripTelegramSdk, viteSingleFile()] : [react()],
  build: mode === 'demo' ? { outDir: 'dist-demo' } : {},
  define: mode === 'demo' ? { __DEMO_SNAPSHOT__: process.env.DEMO_SNAPSHOT ?? 'undefined' } : {},
  server: {
    host: true,
    proxy: { '/api': 'http://localhost:8080' },
  },
}));
