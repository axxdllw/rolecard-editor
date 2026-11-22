/**
 * 提示词预览里“模拟聊天”的测试数据读写，按卡存在本地库（不写进卡）。
 */
import { useEffect, useRef, useState } from 'react'
import type { CharacterCardV3 } from '@/core/card/types'
import { db, type CardScanTestData } from '@/db/db'

export type ScanTestMessage = CardScanTestData['messages'][number]

export function getCardGreetings(card: CharacterCardV3): string[] {
  return [card.data.first_mes ?? '', ...(card.data.alternate_greetings ?? [])]
}

function defaultScanTest(hasFirstMes: boolean): CardScanTestData {
  return {
    greeting: hasFirstMes ? 0 : -1,
    messages: [{ role: 'user', text: '' }],
  }
}

export function normalizeScanTest(raw: Partial<CardScanTestData> | undefined, hasFirstMes: boolean): CardScanTestData {
  const greeting = typeof raw?.greeting === 'number' && Number.isInteger(raw.greeting) ? raw.greeting : hasFirstMes ? 0 : -1
  const messages: ScanTestMessage[] = Array.isArray(raw?.messages)
    ? raw.messages
        .filter((m): m is ScanTestMessage => Boolean(m) && (m.role === 'user' || m.role === 'char') && typeof m.text === 'string')
        .map((m) => ({ role: m.role, text: m.text }))
    : []
  return {
    greeting,
    messages: messages.length > 0 ? messages : [{ role: 'user', text: '' }],
  }
}

/** 按卡持久化模拟聊天数据：本地 state + 500ms 防抖写回 Dexie，卸载时立刻落库 */
export function useScanTestData(cardId: string, hasFirstMes: boolean) {
  const defaultHasFirstMesRef = useRef(hasFirstMes)
  const [data, setData] = useState<CardScanTestData>(() => defaultScanTest(hasFirstMes))
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef<CardScanTestData | null>(null)
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    dirtyRef.current = false
    const fallbackFirstMes = defaultHasFirstMesRef.current
    void db.cards.get(cardId).then((record) => {
      if (cancelled || dirtyRef.current) return
      const loaded = record?.scanTest ? normalizeScanTest(record.scanTest, fallbackFirstMes) : defaultScanTest(fallbackFirstMes)
      latestRef.current = loaded
      setData(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [cardId])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        if (latestRef.current) {
          void db.cards.update(cardId, { scanTest: latestRef.current })
        }
      }
    }
  }, [cardId])

  const update = (next: CardScanTestData) => {
    const normalized = normalizeScanTest(next, hasFirstMes)
    dirtyRef.current = true
    latestRef.current = normalized
    setData(normalized)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (latestRef.current) {
        void db.cards.update(cardId, { scanTest: latestRef.current })
      }
    }, 500)
  }

  return [data, update] as const
}
