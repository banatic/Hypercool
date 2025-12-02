import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './firebase';
import { Login } from './pages/Login';
import { CalendarPage } from './pages/CalendarPage';
import { MessagesPage } from './pages/MessagesPage';
import { TodosPage } from './pages/TodosPage';
import { Layout } from './components/Layout';
import './App.css';

const AuthGuard = () => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setIsAuthenticated(!!user);
    });
    return () => unsubscribe();
  }, []);

  if (isAuthenticated === null) {
    return <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>Loading...</div>;
  }

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AuthGuard />}>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/calendar" replace />} />
            <Route path="calendar" element={<CalendarPage />} />
            <Route path="todos" element={<TodosPage />} />
            <Route path="messages" element={<MessagesPage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
