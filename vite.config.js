import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'frontend',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'frontend/index.html'),
        login: resolve(__dirname, 'frontend/login.html'),
        changePassword: resolve(__dirname, 'frontend/change-password.html'),
        admin: resolve(__dirname, 'frontend/admin.html'),
        vault: resolve(__dirname, 'frontend/vault.html')
      }
    }
  }
});
