/* global process */
/**
 * @file vite.config.js
 * @brief Vite configuration module for local development proxying and production builds.
 * 
 * Configures the DevServer API proxies (routing api/oauth2/graphql requests to local ws-server),
 * custom build chunk splitting for performance optimization, and a custom build post-hook
 * to inject a cache-busting version hash directly into the output Service Worker file.
 */

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

// Resolve dirname since ES Modules do not support __dirname globally
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load workspace environment variables
  const env = loadEnv(mode, process.cwd(), '');
  // Default API server target if VITE_API_TARGET is not specified
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:3111';

  return {
    base: './', // Use relative base for assets (required for Cordova/Capacitor file:// loaded assets)
    test: {
      globals: true,
      environment: 'node',
      setupFiles: './src/test/setup.js',
    },
    plugins: [
      react(),
      {
        name: 'inject-sw-version',
        // Hook called after the production bundle is completely compiled
        closeBundle() {
          const swPath = path.resolve(__dirname, '../ws-server/frontend-dist/sw.js');
          if (fs.existsSync(swPath)) {
            let content = fs.readFileSync(swPath, 'utf-8');
            const distDir = path.resolve(__dirname, '../ws-server/frontend-dist');
            // Gather all chunk files to compute a version hash
            const files = fs.readdirSync(distDir).filter(f => f.endsWith('.js') || f.endsWith('.css'));
            const hash = crypto.createHash('md5');
            for (const f of files.sort()) {
              if (f === 'sw.js') continue;
              hash.update(fs.readFileSync(path.join(distDir, f)));
            }
            const version = 'v' + hash.digest('hex').slice(0, 12);
            // Replace the hardcoded sw cache shell name with the new hashed name
            content = content.replace(/tanoclo-shell-v[a-z0-9]+/g, `tanoclo-shell-${version}`);
            fs.writeFileSync(swPath, content, 'utf-8');
            console.log(`\n[Plugin] Injected Service Worker build version: ${version}`);
          }
        }
      }
    ],
    build: {
      // Direct build output directory inside the websocket server public path
      outDir: '../ws-server/frontend-dist',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Manual chunk splitting to optimize vendor bundle sizes and browser cache efficiency
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('leaflet') || id.includes('react-leaflet')) {
                return 'leaflet-vendor';
              }
              if (id.includes('chart.js') || id.includes('react-chartjs-2')) {
                return 'chart-vendor';
              }
              if (id.includes('lucide-react')) {
                return 'icons-vendor';
              }
              return 'vendor';
            }
          }
        }
      }
    },
    server: {
      port: 5173,
      // API proxying for local web development without CORS headaches
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
        '/oauth2': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
        '/graphql': {
          target: apiTarget,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
})
