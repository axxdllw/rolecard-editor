/**
 * 自动保存：内容变化后停顿一会儿写入；页面隐藏或组件卸载时立即保存。
 */
import { useEffect, useRef, useState } from 'react'
import type { DocStore } from './docStore'

export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'

/**
 * 自动保存：内容变化后停顿 delay 毫秒写入；页面隐藏或组件卸载时立即保存。
 */
export function useAutosave<T>(store: DocStore<T>, save: (doc: T) => Promise<void>, delay = 600): SaveStatus {
  const [status, setStatus] = useState<SaveStatus>('saved')
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let savedVersion = store.getState().version
    let running: Promise<void> | null = null

    const flush = async () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const { doc, version } = store.getState()
      if (!doc || version === savedVersion) return
      if (running) await running
      setStatus('saving')
      running = saveRef
        .current(doc)
        .then(() => {
          savedVersion = version
          setStatus(store.getState().version === version ? 'saved' : 'pending')
        })
        .catch((error) => {
          console.error('保存失败', error)
          setStatus('error')
        })
        .finally(() => {
          running = null
        })
      await running
    }

    const unsubscribe = store.subscribe((state, prev) => {
      if (state.version === prev.version) return
      if (prev.doc === null || state.version === 0) {
        savedVersion = state.version
        return
      }
      setStatus('pending')
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void flush(), delay)
    })

    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)

    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      void flush()
    }
  }, [store, delay])

  return status
}
