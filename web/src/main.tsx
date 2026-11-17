import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import Layout from './App'
import { Loading } from './components/ui'
import { AppProvider } from './context'
import { I18nProvider } from './i18n'
import { ScanProvider } from './scan'
import ReviewPage from './pages/ReviewPage'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } })

// 数据路由(createBrowserRouter)才支持"离开页面前提示未保存的修改"(useBlocker)
const router = createBrowserRouter([
  {
    element: <Layout />,
    HydrateFallback: () => <div className="shell"><header className="top"><div className="brand">🧾</div></header><div className="content"><Loading /></div></div>,
    children: [
      { index: true, element: <Navigate to="/review" replace /> },
      { path: 'review/:id?', element: <ReviewPage /> },
      // 数据表格和图表库比较大,进入对应页面时才加载,让审核页打开更快
      { path: 'data', lazy: async () => ({ Component: (await import('./pages/DataPage')).default }) },
      { path: 'analytics', lazy: async () => ({ Component: (await import('./pages/AnalyticsPage')).default }) },
      { path: 'activity', lazy: async () => ({ Component: (await import('./pages/ActivityPage')).default }) },
      { path: '*', element: <Navigate to="/review" replace /> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <AppProvider>
          <ScanProvider>
            <RouterProvider router={router} />
          </ScanProvider>
        </AppProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
)
