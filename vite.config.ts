import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs are required because the Electron shell loads the built
  // index.html over file://, where absolute "/assets/..." paths resolve to the
  // filesystem root and fail to load.
  base: './',
})
