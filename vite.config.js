import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = `http://127.0.0.1:${process.env.PORT || env.PORT || 2222}`;
  return {
  root: 'frontend',
  server: {
    proxy: { '/api': { target }, '/uploads': { target } }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'frontend/index.html'),
        login: resolve(__dirname, 'frontend/login.html'),
        changePassword: resolve(__dirname, 'frontend/change-password.html'),
        admin: resolve(__dirname, 'frontend/admin.html'),
        vault: resolve(__dirname, 'frontend/vault.html'),
        ledger: resolve(__dirname, 'frontend/ledger.html'),
        screen: resolve(__dirname, 'frontend/screen.html')
      }
    }
  }
  };
});
