import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    // 절대 경로로 지정: 상위 저장소(D:/dev/Hypercool)의 vite 설정과 루트가 섞여
    // './src/setupTests.ts' 가 엉뚱한 위치로 풀리는 문제를 막는다.
    setupFiles: [fileURLToPath(new URL('./src/setupTests.ts', import.meta.url))],
  },
})
