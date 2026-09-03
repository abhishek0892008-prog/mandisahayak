import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The dev server proxies /api to the backend so the browser sees one origin.
 *
 * This matters more than convenience: the session and CSRF cookies are
 * SameSite=Lax, and the backend deliberately ships no CORS middleware. Serving
 * the API through the same origin is what makes cookie authentication work in
 * development without relaxing a single control on the server.
 *
 * Override the target with VITE_API_PROXY_TARGET when the backend is elsewhere.
 */
export default defineConfig(({ mode }) => {
  const target = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000'

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      proxy: {
        '/api': {
          target,
          changeOrigin: false,
        },
      },
    },
    preview: {
      proxy: {
        '/api': { target, changeOrigin: false },
      },
    },
    define: {
      __DEV_MODE__: JSON.stringify(mode !== 'production'),
    },
    // The automatic JSX runtime, stated explicitly so test files transform the
    // same way application files do without importing React by hand.
    esbuild: { jsx: 'automatic' },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.js'],
      css: false,
      restoreMocks: true,
      include: ['src/**/*.test.{js,jsx}'],
    },
  }
})
