/**
 * 界面设置，保存在 localStorage。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type LibrarySort = 'updatedAt' | 'createdAt' | 'name'
export type LibraryView = 'grid' | 'list'

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
  /** 编辑页是否打开渲染预览侧栏 */
  renderPanelOpen: boolean
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
      set: (patch) => set(patch),
    }),
    { name: 'rce-settings' },
  ),
)
