import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'

/**
 * 测试用样本卡。样本卡是第三方作品，不放进仓库：本地放到 samples/弗洛洛2.png 就会运行依赖它的用例，没有时这些用例跳过。
 * 注意：跳过的 describe 函数体仍会执行，函数体里直接用到样本卡的计算要放进 beforeAll 或 it。
 */
const SAMPLE_PNG = resolve(import.meta.dirname, '../samples/弗洛洛2.png')

export const hasSample = existsSync(SAMPLE_PNG)

/** 样本卡的 PNG 字节；没有样本卡时为空 */
export const sampleBytes = hasSample ? new Uint8Array(readFileSync(SAMPLE_PNG)) : new Uint8Array()

export const describeWithSample = describe.skipIf(!hasSample)
export const itWithSample = it.skipIf(!hasSample)

/** 不带角色卡数据的普通 PNG（项目自己的图标），只需要一张图片的用例用它 */
export const plainPng = new Uint8Array(readFileSync(resolve(import.meta.dirname, '../public/icons/icon-192.png')))

export interface LocalCardFile {
  label: string
  bytes: Uint8Array
  kind: 'png' | 'charx'
}

/**
 * 读取环境变量 LOCAL_CARD_DIR 指定的本机测试卡目录：
 * 递归扫描 .png 和 .charx 文件（跳过 .json/.zip/.rar 等其他文件），返回序号标签与原始字节。
 * 目录未设置或不存在时返回空数组。
 */
export function loadLocalCards(): LocalCardFile[] {
  const dir = process.env.LOCAL_CARD_DIR ?? ''
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return []

  const files: { path: string; kind: 'png' | 'charx' }[] = []
  const scan = (currentDir: string) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        scan(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.png')) {
        files.push({ path: fullPath, kind: 'png' })
      } else if (lower.endsWith('.charx')) {
        files.push({ path: fullPath, kind: 'charx' })
      }
    }
  }
  scan(dir)

  return files.map((file, index) => ({
    label: `#${index + 1}`,
    bytes: new Uint8Array(readFileSync(file.path)),
    kind: file.kind,
  }))
}
