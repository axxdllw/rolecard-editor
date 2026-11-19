import { liveQuery } from 'dexie'
import { useEffect, useState, type DependencyList } from 'react'

/** 订阅 Dexie 查询，数据变化时自动刷新 */
export function useLive<T>(query: () => Promise<T> | T, deps: DependencyList): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined)
  useEffect(() => {
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (error) => console.error('查询失败', error),
    })
    return () => sub.unsubscribe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return value
}
