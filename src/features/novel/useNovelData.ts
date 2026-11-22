/**
 * 小说转卡的数据订阅与防抖保存 hooks。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { planChunks } from '@/core/novel/chunk'
import { mergeEntities } from '@/core/novel/merge'
import { EMPTY_OVERRIDES } from '@/core/novel/types'
import { db } from '@/db/db'
import { useLive } from '@/db/useLive'
import { useActiveAiProfile, useAiSettings } from '@/lib/aiSettings'
import { chunkResults, listChunkRecords, normalizeNovel } from '@/services/novels'

const EMPTY_RECORDS: Awaited<ReturnType<typeof listChunkRecords>> = []

/**
 * 订阅小说项目记录、分块计划、抽取记录、合并后的实体和当前选用的 AI 接口。
 * novel 为 undefined 表示加载中，为 null 表示不存在或已删除。
 */
export function useNovelData(novelId: string) {
  const raw = useLive(async () => (await db.novels.get(novelId)) ?? null, [novelId])
  const novel = useMemo(() => (raw ? normalizeNovel(raw) : raw), [raw])
  const recordsLive = useLive(() => listChunkRecords(novelId), [novelId])
  const records = recordsLive ?? EMPTY_RECORDS

  const plans = useMemo(() => {
    if (!novel) return []
    return planChunks(
      novel.toc.map((c) => c.chars),
      novel.selected,
      { chunkChars: novel.settings.chunkChars, sampleCount: novel.settings.sampleCount },
      novel.toc,
    )
  }, [novel])

  const results = useMemo(() => chunkResults(records, plans), [records, plans])
  const deferredResults = useDeferredValue(results)
  const review = novel?.review ?? EMPTY_OVERRIDES
  const deferredReview = useDeferredValue(review)

  const entities = useMemo(() => mergeEntities(deferredResults, deferredReview), [deferredResults, deferredReview])
  const chunkCount = results.length

  const profiles = useAiSettings((s) => s.profiles)
  const activeProfile = useActiveAiProfile()
  const profileId = novel?.settings.profileId ?? null
  const profile = useMemo(() => {
    if (profileId) {
      return profiles.find((p) => p.id === profileId) ?? activeProfile
    }
    return activeProfile
  }, [profileId, profiles, activeProfile])

  return {
    novel,
    records,
    recordsLoaded: recordsLive !== undefined,
    plans,
    results,
    entities,
    chunkCount,
    profile,
    profiles,
  }
}

/**
 * 输入框防抖写库：本地立即响应输入，延迟保存；失焦或组件卸载时立即把未保存的内容写进库。
 * 不在 effect 里同步 setState，避免触发 react-hooks/set-state-in-effect。
 */
export function useDebouncedField(externalValue: string, onSave: (value: string) => void, delay = 400) {
  const [draft, setDraft] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ value: string; save: (v: string) => void } | null>(null)

  const value = draft ?? externalValue

  const onChange = (next: string) => {
    setDraft(next)
    pendingRef.current = { value: next, save: onSave }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) pending.save(pending.value)
    }, delay)
  }

  const onBlur = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) pending.save(pending.value)
    setDraft(null)
  }

  const setImmediate = (next: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    setDraft(null)
    onSave(next)
  }

  const cancel = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    setDraft(null)
  }

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) pending.save(pending.value)
    },
    [],
  )

  return { value, onChange, onBlur, setImmediate, cancel }
}
