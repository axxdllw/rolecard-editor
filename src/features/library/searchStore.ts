/**
 * 卡库的搜索词和搜索模式。放在内存里，从编辑页返回卡库时还在。
 */
import { create } from 'zustand'

interface LibrarySearchState {
  query: string
  /** 在卡片内容里搜（全文搜索） */
  fullText: boolean
}

export const useLibrarySearch = create<LibrarySearchState>(() => ({ query: '', fullText: false }))

export function setLibrarySearch(patch: Partial<LibrarySearchState>): void {
  useLibrarySearch.setState(patch)
}
