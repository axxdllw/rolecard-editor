/**
 * 界面设置，保存在 localStorage。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SCAN_SETTINGS, type ScanSettings } from '@/core/lorebook/activate'

export type LibrarySort = 'updatedAt' | 'createdAt' | 'name'
export type LibraryView = 'grid' | 'list'
export type SidePanelTab = 'render' | 'assistant'

export interface CustomTemplate {
  id: string
  label: string
  content: string
}

interface SettingsState {
  /** 预览时 {{user}} 替换成的名字 */
  previewUserName: string
  /** 常驻内容 token 预算，超过时在检查里提示 */
  constantTokenBudget: number
  librarySort: LibrarySort
  libraryView: LibraryView
  /** 上次提醒备份的时间 */
  lastBackupAt: number | null
  /** 自己保存的描述模板 */
  customTemplates: CustomTemplate[]
  /** 编辑页侧栏是否打开 */
  renderPanelOpen: boolean
  /** 编辑页侧栏当前面板 */
  sidePanelTab: SidePanelTab
  /** 提示词预览里哪些世界书条目算作触发；切换标签后保持 */
  promptPreviewMode: 'constant' | 'all' | 'simulate'
  /** 世界书触发模拟的扫描设置（对照酒馆的世界书全局设置） */
  scanSettings: ScanSettings
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      previewUserName: '用户',
      constantTokenBudget: 8000,
      librarySort: 'updatedAt',
      libraryView: 'grid',
      lastBackupAt: null,
      customTemplates: [],
      renderPanelOpen: false,
      sidePanelTab: 'render',
      promptPreviewMode: 'constant',
      scanSettings: DEFAULT_SCAN_SETTINGS,
      set: (patch) => set(patch),
    }),
    { name: 'rce-settings' },
  ),
)
