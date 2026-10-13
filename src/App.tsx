// src/App.tsx
import { lazy, Suspense, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuth } from './hooks/useAuth';
import { resolveLandingRoute } from './utils/roles';

// ────────────────────────────────────────────────────────────
// Lazy-loaded routes
// ------------------------------------------------------------
// DispatcherGeoMap is ~4,000 lines and pulls in the entire
// Google Maps SDK, socket.io-client, and WebRTC. Loading it
// eagerly means the map's <LoadScript> begins initializing
// BEFORE the /dispatcher route even matches — which is one of
// the root causes of the "LoadScript has been reloaded
// unintentionally" spam in the console.
//
// Making it lazy ensures <LoadScript> only mounts once the
// dispatcher route is actually visited, and only once.
// ────────────────────────────────────────────────────────────
const Login = lazy(() => import('./pages/Login'));
const DispatcherGeoMap = lazy(() => import('./components/Map/DispatcherGeoMap'));
const MainLayout = lazy(() => import('./components/Layout/MainLayout'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Incidents = lazy(() => import('./pages/Incidents'));
const IncidentDetail = lazy(() => import('./pages/IncidentDetail'));
const Units = lazy(() => import('./pages/Units'));
const Sensors = lazy(() => import('./pages/Sensors'));
const Reports = lazy(() => import('./pages/Reports'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const AuditLogs = lazy(() => import('./pages/AuditLogs'));
const LiveMap = lazy(() => import('./pages/LiveMap'));

// ────────────────────────────────────────────────────────────
// Full-screen loading fallback
// Shown while a lazy route chunk is downloading.
// ────────────────────────────────────────────────────────────
const FullScreenLoader = () => (
  <div
    style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0d0d1a',
      color: 'rgba(255,255,255,0.7)',
      gap: 16,
    }}
  >
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        border: '3px solid rgba(255,255,255,0.1)',
        borderTopColor: '#4d9aff',
        animation: 'app-spin 0.8s linear infinite',
      }}
    />
    <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.5px' }}>
      Loading…
    </div>
    <style>{`@keyframes app-spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<FullScreenLoader />}>
            <AppRoutes />
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

const AppRoutes: React.FC = () => {
  const { user } = useAuth();

  // ⚠️ Only compute the landing route when we actually know who the
  // user is. If `user` is undefined (still resolving), we return null
  // and let ProtectedRoute handle the redirect once auth settles.
  // This prevents a double-<Navigate> flash: '/' → '/login' → '/dispatcher'.
  const defaultLanding = useMemo(() => {
    if (!user) return null;
    try {
      return resolveLandingRoute(user);
    } catch (err) {
      console.error('[App] resolveLandingRoute failed:', err);
      return null;
    }
  }, [user]);

  return (
    <Routes>
      {/* ── Public ─────────────────────────────────────────── */}
      <Route path="/login" element={<Login />} />

      {/* ── Dispatcher only — full-screen map ──────────────── */}
      <Route
        path="/dispatcher"
        element={
          <ProtectedRoute requiredRoles={['Dispatcher']}>
            <DispatcherGeoMap />
          </ProtectedRoute>
        }
      />

      {/* ── Admin only — with sidebar layout ───────────────── */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute requiredRoles={['Administrator']}>
            <MainLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/admin/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="live-map" element={<LiveMap />} />
        <Route path="incidents" element={<Incidents />} />
        <Route path="incidents/:id" element={<IncidentDetail />} />
        <Route path="units" element={<Units />} />
        <Route path="reports" element={<Reports />} />
        <Route path="sensors" element={<Sensors />} />
        <Route path="users" element={<UserManagement />} />
        <Route path="audit-logs" element={<AuditLogs />} />
      </Route>

      {/* ── Root redirect based on role ────────────────────── */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            {defaultLanding
              ? <Navigate to={defaultLanding} replace />
              : <FullScreenLoader />}
          </ProtectedRoute>
        }
      />

      {/* ── Unauthorized ───────────────────────────────────── */}
      <Route
        path="/unauthorized"
        element={
          <div
            style={{
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0d0d1a',
              color: '#fff',
              padding: 24,
              textAlign: 'center',
            }}
          >
            <h2 style={{ fontWeight: 700 }}>Unauthorized Access</h2>
            <p style={{ color: 'rgba(255,255,255,0.7)' }}>
              You don&apos;t have permission to access this page.
            </p>
            <a
              href="/"
              style={{
                color: '#4d9aff',
                fontWeight: 600,
                marginTop: 12,
                textDecoration: 'underline',
              }}
            >
              Return Home
            </a>
          </div>
        }
      />

      {/* ── 404 ────────────────────────────────────────────── */}
      <Route
        path="*"
        element={
          <div
            style={{
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#0d0d1a',
              color: '#fff',
              padding: 24,
              textAlign: 'center',
            }}
          >
            <h1 style={{ fontSize: 64, fontWeight: 800 }}>404</h1>
            <h2 style={{ fontWeight: 600 }}>Page Not Found</h2>
            <p style={{ color: 'rgba(255,255,255,0.7)' }}>
              The page you&apos;re looking for doesn&apos;t exist.
            </p>
            <a
              href="/"
              style={{
                color: '#4d9aff',
                fontWeight: 600,
                marginTop: 12,
                textDecoration: 'underline',
              }}
            >
              Return Home
            </a>
          </div>
        }
      />
    </Routes>
  );
};

export default App;