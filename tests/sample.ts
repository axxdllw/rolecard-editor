import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
