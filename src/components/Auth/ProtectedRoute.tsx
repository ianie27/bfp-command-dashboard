// src/components/Auth/ProtectedRoute.tsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { Spinner, Container } from 'react-bootstrap';
import { extractRole, normalizeRole, isAdministrator } from '../../utils/roles';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRoles?: string[];
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRoles,
}) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Container
        className="d-flex justify-content-center align-items-center"
        style={{ minHeight: '100vh', background: '#0b132b' }}
      >
        <Spinner animation="border" role="status" variant="danger" />
      </Container>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requiredRoles && requiredRoles.length > 0) {
    const rawRole = extractRole(user);
    const userRole = normalizeRole(rawRole);
    const allowed = requiredRoles.map(normalizeRole);

    // Admins bypass role checks
    if (!isAdministrator(user) && !allowed.includes(userRole)) {
      console.warn(
        `⛔ [ProtectedRoute] Denied. role="${rawRole}" (norm="${userRole}") ` +
          `not in [${requiredRoles.join(', ')}]`
      );
      return <Navigate to="/unauthorized" replace />;
    }
  }

  return <>{children}</>;
};

export default ProtectedRoute;