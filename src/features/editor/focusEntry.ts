/**
 * 用户在世界书页当前选中的条目（目录序号，从 1 开始），供侧栏 AI 助手自动附带全文。
 */
import { create } from 'zustand'

interface FocusEntryState {
  /** 目录序号（从 1 开始）；未选中或不在世界书页时为 null */
  index: number | null
}

export const useFocusEntry = create<FocusEntryState>(() => ({ index: null }))

export function setFocusEntry(index: number | null): void {
  useFocusEntry.setState({ index })
}
