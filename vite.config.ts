import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react({
      // React 플러그인에서 esbuild 옵션 전달
      jsxRuntime: 'automatic',
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  // tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // esbuild 옵션 명시적 설정
  esbuild: {
    target: 'es2020',
    // 최신 문법 지원
    supported: {
      'top-level-await': true,
    },
  },
  build: {
    target: 'es2020',
    // 소스맵 생성 (디버깅용)
    sourcemap: false,
    // 청크 크기 경고 비활성화
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: './index.html',
        'calendar-widget': './calendar-widget.html',
      },
    },
  },
  // 최적화 옵션
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2020',
    },
  },
}));

