/**
 * 改名向导的称谓词表和匹配方案，保存在 localStorage。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { uuid } from '@/core/util/id'
import { DEFAULT_TITLE_VOCAB, type RenameConfig, type TitleVocab } from '@/core/search/rename'

export interface RenamePreset {
  id: string
  name: string
  config: RenameConfig
  /** 手动勾选/取消的规则，键是规则 id */
  toggles: Record<string, boolean>
  /** 手动改过的新叫法，键是规则 id */
  overrides: Record<string, string>
  savedAt: number
}

interface RenameStoreState {
  vocab: TitleVocab
  presets: RenamePreset[]
  setVocab: (vocab: TitleVocab) => void
  savePreset: (preset: Omit<RenamePreset, 'id' | 'savedAt'>) => void
  deletePreset: (id: string) => void
}

export const useRenameStore = create<RenameStoreState>()(
  persist(
    (set) => ({
      vocab: DEFAULT_TITLE_VOCAB,
      presets: [],
      setVocab: (vocab) => set({ vocab }),
      savePreset: (preset) =>
        set((s) => {
          const existing = s.presets.find((p) => p.name === preset.name)
          const next: RenamePreset = { ...preset, id: existing?.id ?? uuid(), savedAt: Date.now() }
          return { presets: existing ? s.presets.map((p) => (p.id === existing.id ? next : p)) : [next, ...s.presets] }
        }),
      deletePreset: (id) => set((s) => ({ presets: s.presets.filter((p) => p.id !== id) })),
    }),
    { name: 'rce-rename' },
  ),
)
