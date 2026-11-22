/**
 * AI 接口设置，保存在 localStorage（不进整库备份，免得 API key 跟着备份文件流出去）。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_MODEL, type AiProfile, type AiProviderKind } from '@/core/ai/types'
import { uuid } from '@/core/util/id'

export const PROVIDER_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 格式（Claude）',
  gemini: 'Gemini（Google）',
}

interface AiSettingsState {
  profiles: AiProfile[]
  activeId: string | null
  /** 新建一个接口配置并设为当前，返回 id */
  addProfile: (kind: AiProviderKind) => string
  updateProfile: (id: string, patch: Partial<Omit<AiProfile, 'id'>>) => void
  removeProfile: (id: string) => void
  setActive: (id: string) => void
}

export const useAiSettings = create<AiSettingsState>()(
  persist(
    (set) => ({
      profiles: [],
      activeId: null,
      addProfile: (kind) => {
        const id = uuid()
        set((s) => ({
          profiles: [...s.profiles, { id, name: PROVIDER_LABELS[kind], kind, baseUrl: '', apiKey: '', model: DEFAULT_MODEL[kind] }],
          activeId: id,
        }))
        return id
      },
      updateProfile: (id, patch) => set((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removeProfile: (id) =>
        set((s) => {
          const profiles = s.profiles.filter((p) => p.id !== id)
          return { profiles, activeId: s.activeId === id ? (profiles[0]?.id ?? null) : s.activeId }
        }),
      setActive: (id) => set({ activeId: id }),
    }),
    { name: 'rce-ai' },
  ),
)

/** 当前使用的接口；没有配置时为 null */
export function useActiveAiProfile(): AiProfile | null {
  return useAiSettings((s) => s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0] ?? null)
}
