import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { DataProvider } from './context/DataContext';
import { useData } from './context/DataStore';
import { Login } from './pages/Login';
import { TodayPage } from './pages/TodayPage';
import { CalendarPage } from './pages/CalendarPage';
import { MessagesPage } from './pages/MessagesPage';
import { WidgetPage } from './pages/WidgetPage';
import { Layout } from './components/Layout';

const Splash = () => (
  <div className="splash" aria-busy="true" aria-label="불러오는 중">
    <span className="brand-mark" />
  </div>
);

const AuthGuard = () => {
  const { user, authLoading } = useData();
  if (authLoading) return <Splash />;
  return user ? <Outlet /> : <Navigate to="/login" replace />;
};

export const AppRoutes = () => (
  <Routes>
    <Route path="/login" element={<Login />} />
    <Route element={<AuthGuard />}>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="today" element={<TodayPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="widget" element={<WidgetPage />} />
        {/* 예전 링크 호환 */}
        <Route path="todos" element={<Navigate to="/calendar" replace />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Route>
    </Route>
  </Routes>
);

function App() {
  return (
    <DataProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </DataProvider>
  );
}

export default App;
