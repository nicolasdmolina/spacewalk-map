import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` serves the app on 127.0.0.1:5320 and sends /api to a running
// Spacewalk server (bin/spacewalk) on its default port.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5320,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4747',
        changeOrigin: true,
        // The server refuses changes from other origins; the dev server is this Mac too.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
  preview: { host: '127.0.0.1', port: 5321, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
});
