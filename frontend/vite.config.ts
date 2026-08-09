import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Strip crossorigin attribute from HTML — unnecessary for WebView2 and can cause issues
function removeCrossorigin(): import('vite').Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), removeCrossorigin()],
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // The bundle only ever runs inside evergreen WebView2 (see MainWindow's WebView2 init), never
    // in an older browser, so there is no reason to pay for Vite's default downlevel target
    // (baseline-widely-available ≈ Chrome 107) — every helper emitted for spread / optional
    // chaining / async is dead weight in a chunk that is parsed on each launch.
    target: 'chrome114',
  },
  server: {
    port: 5173,
  },
})
