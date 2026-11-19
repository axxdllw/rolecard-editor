import { BookOpenIcon, LibraryIcon, SettingsIcon } from 'lucide-react'
import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { ConfirmHost } from '@/components/confirm'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConflictHost } from '@/features/library/importFlow'
import LibraryPage from '@/features/library/LibraryPage'
import { cn } from '@/lib/utils'
import { requestPersistentStorage } from '@/services/backup'

const CardEditorPage = lazy(() => import('@/features/editor/CardEditorPage'))
const LorebookLibraryPage = lazy(() => import('@/features/lorebook-library/LorebookLibraryPage'))
const LorebookEditorPage = lazy(() => import('@/features/lorebook-library/LorebookEditorPage'))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage'))

const NAV = [
  { to: '/', label: '卡库', icon: LibraryIcon, end: true },
  { to: '/lorebooks', label: '世界书库', icon: BookOpenIcon, end: false },
  { to: '/settings', label: '设置', icon: SettingsIcon, end: false },
]

function TopNav() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-1 px-4">
        <span className="mr-3 font-semibold">角色卡编辑器</span>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground',
                isActive && 'bg-muted text-foreground',
              )
            }
          >
            <Icon className="size-4" />
            <span className="hidden sm:inline">{label}</span>
          </NavLink>
        ))}
      </div>
    </header>
  )
}

function Loading() {
  return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>
}

export default function App() {
  useEffect(() => {
    void requestPersistentStorage()
  }, [])

  return (
    <HashRouter>
      <TooltipProvider>
        <div className="flex min-h-svh flex-col">
          <TopNav />
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<LibraryPage />} />
              <Route path="/card/:id" element={<CardEditorPage />} />
              <Route path="/lorebooks" element={<LorebookLibraryPage />} />
              <Route path="/lorebook/:id" element={<LorebookEditorPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<p className="p-10 text-center">页面不存在</p>} />
            </Routes>
          </Suspense>
        </div>
        <Toaster position="top-center" richColors closeButton />
        <ConfirmHost />
        <ConflictHost />
      </TooltipProvider>
    </HashRouter>
  )
}
