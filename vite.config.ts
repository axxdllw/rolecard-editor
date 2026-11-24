/// <reference types="vitest/config" />
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Tauri CLI 跑 beforeDevCommand / beforeBuildCommand 时会带上 TAURI_ENV_* 环境变量
const isTauri = !!process.env.TAURI_ENV_PLATFORM

// https://vite.dev/config/
export default defineConfig({
  // 相对路径，打包产物放在任意子目录（如 GitHub Pages 的仓库路径）都能用
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 桌面版不需要离线缓存和“安装到桌面”
      disable: isTauri,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '角色卡编辑器',
        short_name: '角色卡',
        description: '管理和编辑 SillyTavern 角色卡，数据只保存在本地',
        lang: 'zh-CN',
        theme_color: '#7c3aed',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // 分词器的词表比较大，也要缓存才能离线估算 token
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  // 代码里用 import.meta.env.TAURI_ENV_PLATFORM 判断是否桌面版，网页版构建时相关分支会被整段删掉
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // 桌面版开发服务器换个端口，不和网页版的 5173 抢
  server: isTauri ? { port: 5174, strictPort: true } : undefined,
  build: {
    // 桌面版单独输出，不覆盖网页版的 dist
    outDir: isTauri ? 'dist-tauri' : 'dist',
    // 分词器词表（约 2MB）和编辑器都是按需加载的，放宽提示阈值
    chunkSizeWarningLimit: 2500,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
