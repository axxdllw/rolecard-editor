/**
 * 生成 PWA 图标（PNG）。用法：node scripts/gen-icons.mjs
 * 不依赖图形库：逐像素绘制（4 倍超采样抗锯齿），zlib 压缩后写 PNG 块。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const FROM = hex('#7c3aed')
const TO = hex('#db2777')

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r)
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

/** 返回 [r,g,b,a]，坐标为 0..1 */
function sample(u, v, { maskable }) {
  // 背景：渐变（普通图标用圆角方形，maskable 铺满）
  const bgInside = maskable ? true : inRoundRect(u, v, 0, 0, 1, 1, 0.22)
  if (!bgInside) return [0, 0, 0, 0]
  const t = (u + v) / 2
  let color = FROM.map((c, i) => c + (TO[i] - c) * t)
  const s = maskable ? 0.8 : 1 // maskable 图标内容缩到安全区
  const o = (1 - s) / 2
  const U = (u - o) / s
  const V = (v - o) / s
  // 卡片
  if (inRoundRect(U, V, 0.27, 0.17, 0.46, 0.66, 0.06)) {
    color = [255, 255, 255]
    // 头像圆
    if ((U - 0.5) ** 2 + (V - 0.36) ** 2 <= 0.095 ** 2) color = FROM.map((c, i) => c + (TO[i] - c) * 0.35)
    // 文字条
    if (inRoundRect(U, V, 0.35, 0.52, 0.3, 0.045, 0.02)) color = [203, 213, 225]
    if (inRoundRect(U, V, 0.35, 0.6, 0.22, 0.045, 0.02)) color = [203, 213, 225]
    if (inRoundRect(U, V, 0.35, 0.68, 0.26, 0.045, 0.02)) color = [226, 232, 240]
  }
  return [...color, 255]
}

function render(size, options) {
  const SS = 4
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [r, g, b, a] = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, options)
          acc[0] += r * a
          acc[1] += g * a
          acc[2] += b * a
          acc[3] += a
        }
      }
      const i = (y * size + x) * 4
      const alpha = acc[3] / (SS * SS)
      buf[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0
      buf[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0
      buf[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0
      buf[i + 3] = Math.round(alpha)
    }
  }
  return encodePng(size, buf)
}

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/icon-192.png', render(192, { maskable: false }))
writeFileSync('public/icons/icon-512.png', render(512, { maskable: false }))
writeFileSync('public/icons/maskable-512.png', render(512, { maskable: true }))
writeFileSync('public/apple-touch-icon.png', render(180, { maskable: true }))
console.log('icons written')
