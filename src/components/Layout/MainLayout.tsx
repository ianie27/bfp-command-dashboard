// src/components/Layout/MainLayout.tsx
import React, { useState } from 'react';
import { Outlet, useNavigate, Link, useLocation } from 'react-router-dom';
import {
  Container,
  Navbar,
  Nav,
  NavDropdown,
  Offcanvas,
  ListGroup,
  Badge,
} from 'react-bootstrap';
import { useAuth } from '../../hooks/useAuth';
import {
  FaMapMarkedAlt,
  FaFire,
  FaTruck,
  FaChartBar,
  FaUsersCog,
  FaMicrochip,
  FaSignOutAlt,
  FaBars,
  FaHome,
  FaClipboardList,
  FaBell,
  FaUserShield,
} from 'react-icons/fa';
import type { IconType } from 'react-icons';
import { Toaster } from 'react-hot-toast';
import type { BFPPersonnel } from '../../types';

// ============================================
// MENU CONFIGURATION
// ============================================

interface MenuItem {
  path: string;
  label: string;
  icon: IconType;
  roles: string[];
}

const ADMIN_MENU_ITEMS: MenuItem[] = [
  { path: '/admin/dashboard', label: 'Dashboard', icon: FaHome, roles: ['Administrator'] },
  { path: '/admin/incidents', label: 'Incidents', icon: FaFire, roles: ['Administrator'] },
  { path: '/admin/units', label: 'Response Units', icon: FaTruck, roles: ['Administrator'] },
  { path: '/admin/reports', label: 'Reports', icon: FaChartBar, roles: ['Administrator'] },
  { path: '/admin/sensors', label: 'IoT Sensors', icon: FaMicrochip, roles: ['Administrator'] },
  { path: '/admin/users', label: 'User Management', icon: FaUsersCog, roles: ['Administrator'] },
  { path: '/admin/audit-logs', label: 'Audit Logs', icon: FaClipboardList, roles: ['Administrator'] },
];

const DISPATCHER_MENU_ITEMS: MenuItem[] = [
  { path: '/dispatcher', label: 'Command Dashboard', icon: FaMapMarkedAlt, roles: ['Dispatcher'] },
];

// ============================================
// HEADER HEIGHT CONSTANT (single source of truth)
// ============================================

const HEADER_HEIGHT = '76px';
const BORDER_COLOR = '#2a2a4e';

// ============================================
// SIDEBAR CONTENT COMPONENT
// ============================================

interface SidebarContentProps {
  user: BFPPersonnel | null;
  filteredMenuItems: MenuItem[];
  onCloseSidebar: () => void;
  onLogout: () => void;
}

const SidebarContent: React.FC<SidebarContentProps> = ({
  user,
  filteredMenuItems,
  onCloseSidebar,
  onLogout
}) => {
  const getUserInitial = (): string => {
    if (!user?.full_name) return 'U';
    return user.full_name.charAt(0).toUpperCase();
  };

  const getUserRoleBadge = (): string => {
    if (!user?.role) return 'Unknown';
    return user.role;
  };

  const getStationAssignment = (): string => {
    if (!user?.station_assignment) return 'Not Assigned';
    return user.station_assignment;
  };

  return (
    <div className="sidebar-content h-100">
      {/* Header — height locked to match the top navbar so the border line is continuous */}
      <div
        className="sidebar-header border-bottom d-flex flex-column justify-content-center"
        style={{
          height: HEADER_HEIGHT,
          padding: '0 1rem',
          borderBottomColor: BORDER_COLOR,
          borderBottomWidth: '1px',
          borderBottomStyle: 'solid',
          flex: '0 0 auto',
        }}
      >
        <h5 className="mb-0 text-danger fw-bold" style={{ lineHeight: 1.1 }}>
          <FaFire className="me-2" />
          EmberNet
        </h5>
        <small className="text-light" style={{ lineHeight: 1.1 }}>
          BFP Admin Portal
        </small>
      </div>

      {/* User Profile Section */}
      <div
        className="user-info p-3 border-bottom bg-dark"
        style={{ borderBottomColor: BORDER_COLOR }}
      >
        <div className="d-flex align-items-center">
          <div className="flex-shrink-0">
            <div
              className="bg-danger text-white rounded-circle d-flex align-items-center justify-content-center"
              style={{ width: 40, height: 40 }}
            >
              {getUserInitial()}
            </div>
          </div>
          <div className="flex-grow-1 ms-3">
            <div className="fw-bold text-white">{user?.full_name || 'Unknown User'}</div>
            <Badge bg="danger">{getUserRoleBadge()}</Badge>
          </div>
        </div>
        <div className="mt-2">
          <small className="text-light">Station: {getStationAssignment()}</small>
        </div>
      </div>

      {/* Navigation Menu - Scrollable */}
      <ListGroup variant="flush" className="sidebar-nav">
        {filteredMenuItems.map((item) => {
          const IconComponent = item.icon;
          return (
            <ListGroup.Item
              key={item.path}
              as={Link}
              to={item.path}
              action
              className="py-3 bg-dark text-white"
              style={{
                backgroundColor: '#212529',
                color: '#ffffff',
                cursor: 'pointer',
                borderBottomColor: BORDER_COLOR,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#343a40';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#212529';
              }}
              onClick={onCloseSidebar}
            >
              <IconComponent className="me-3 text-danger" />
              <span>{item.label}</span>
            </ListGroup.Item>
          );
        })}

        {/* Logout Button inside scrollable area */}
        <ListGroup.Item
          action
          className="py-3 bg-dark"
          style={{
            backgroundColor: '#212529',
            color: '#dc3545',
            cursor: 'pointer',
            borderBottomColor: BORDER_COLOR,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#2c2c2c';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#212529';
          }}
          onClick={onLogout}
        >
          <FaSignOutAlt className="me-3" />
          <span>Logout</span>
        </ListGroup.Item>
      </ListGroup>
    </div>
  );
};

// ============================================
// MAIN LAYOUT COMPONENT
// ============================================

const MainLayout: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [showSidebar, setShowSidebar] = useState<boolean>(false);

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login');
  };

  const handleCloseSidebar = (): void => {
    setShowSidebar(false);
  };

  // Role-based configuration
  const isAdmin = user?.role === 'Administrator';
  const isDispatcher = user?.role === 'Dispatcher';

  const menuItems = isAdmin ? ADMIN_MENU_ITEMS : DISPATCHER_MENU_ITEMS;

  const filteredMenuItems: MenuItem[] = menuItems.filter(item =>
    !item.roles || (user?.role && item.roles.includes(user.role))
  );

  const getPageTitle = (): string => {
    const path = location.pathname;
    const menuItem = menuItems.find(item => item.path === path);
    if (menuItem) return menuItem.label;

    if (path.includes('/incidents/')) return 'Incident Details';
    if (path.includes('/units/')) return 'Unit Details';
    if (path.includes('/sensors/')) return 'Sensor Details';

    return isDispatcher ? 'Command Dashboard' : 'Dashboard';
  };

  // ============================================
  // DISPATCHER VIEW - DARK MODE CONTENT
  // ============================================

  if (isDispatcher) {
    return (
      <>
        <Toaster position="top-right" />
        <div className="dispatcher-layout" style={{ backgroundColor: '#0f0f1a' }}>
          <Navbar bg="dark" variant="dark" className="dispatcher-header py-2">
            <Container fluid>
              <Navbar.Brand className="text-white">
                <FaFire className="me-2 text-danger" />
                <span className="fw-bold">EmberNet Command</span>
              </Navbar.Brand>
              <div className="d-flex align-items-center">
                <Badge bg="danger" className="me-3 px-3 py-2">
                  <FaBell className="me-1" /> LIVE
                </Badge>
                <span className="text-white me-3">{user?.full_name}</span>
                <NavDropdown
                  title={<FaFire className="text-danger" />}
                  id="user-dropdown"
                  align="end"
                  menuVariant="dark"
                >
                  <NavDropdown.Item onClick={handleLogout} className="text-danger">
                    <FaSignOutAlt className="me-2" />
                    Logout
                  </NavDropdown.Item>
                </NavDropdown>
              </div>
            </Container>
          </Navbar>

          <div className="dispatcher-content">
            <Outlet />
          </div>
        </div>
      </>
    );
  }

  // ============================================
  // ADMINISTRATOR VIEW - DARK MODE CONTENT AREA
  // ============================================

  return (
    <>
      <Toaster position="top-right" />

      {/* Mobile Navbar */}
      <Navbar bg="dark" variant="dark" expand={false} className="d-lg-none py-3">
        <Container fluid>
          <Navbar.Brand className="text-white">
            <FaFire className="me-2 text-danger" />
            <span className="fw-bold">EmberNet Admin</span>
          </Navbar.Brand>
          <Nav className="ms-auto">
            <Nav.Link onClick={() => setShowSidebar(true)} className="text-white">
              <FaBars size={24} />
            </Nav.Link>
          </Nav>
        </Container>
      </Navbar>

      {/* Mobile Sidebar (Offcanvas) */}
      <Offcanvas show={showSidebar} onHide={handleCloseSidebar} bg="dark">
        <Offcanvas.Header closeButton closeVariant="white">
          <Offcanvas.Title className="text-white">EmberNet Menu</Offcanvas.Title>
        </Offcanvas.Header>
        <Offcanvas.Body className="p-0">
          <SidebarContent
            user={user}
            filteredMenuItems={filteredMenuItems}
            onCloseSidebar={handleCloseSidebar}
            onLogout={handleLogout}
          />
        </Offcanvas.Body>
      </Offcanvas>

      {/* Desktop Layout */}
      <div className="d-flex">
        {/* Desktop Sidebar */}
        <div
          className="sidebar-desktop d-none d-lg-block"
          style={{
            width: '280px',
            backgroundColor: '#212529',
            overflowY: 'auto',
            overflowX: 'hidden',
            flex: '0 0 280px',
          }}
        >
          <SidebarContent
            user={user}
            filteredMenuItems={filteredMenuItems}
            onCloseSidebar={handleCloseSidebar}
            onLogout={handleLogout}
          />
        </div>

        {/* Main Content Area - DARK MODE THEME */}
        <div
          className="main-content flex-grow-1 d-flex flex-column"
          style={{ minHeight: '100vh', backgroundColor: '#0f0f1a', minWidth: 0 }}
        >
          {/* Top Navbar - Dark Mode (height matches the sidebar header) */}
          <Navbar
            className="border-bottom px-4 d-flex align-items-center flex-shrink-0"
            style={{
              backgroundColor: '#1a1a2e',
              borderBottomColor: BORDER_COLOR,
              borderBottomWidth: '1px',
              borderBottomStyle: 'solid',
              height: HEADER_HEIGHT,
              paddingTop: 0,
              paddingBottom: 0,
            }}
          >
            <Container fluid className="h-100 d-flex align-items-center px-0">
              <Navbar.Brand className="d-none d-lg-block mb-0">
                <h4 className="mb-0 text-capitalize" style={{ color: '#ffffff' }}>
                  {getPageTitle()}
                </h4>
              </Navbar.Brand>
              <Nav className="ms-auto">
                <div className="d-flex align-items-center">
                  <FaUserShield className="me-2" style={{ color: '#dc3545', fontSize: '1rem' }} />
                  <span style={{ color: '#dc3545', fontWeight: 500, fontSize: '0.95rem' }}>
                    Administrator
                  </span>
                </div>
              </Nav>
            </Container>
          </Navbar>

          {/* Page Content */}
          <Container fluid className="p-4 flex-grow-1">
            <Outlet />
          </Container>
        </div>
      </div>

      {/* Global Styles */}
      <style>{`
        /* Sidebar scroll styling */
        .sidebar-desktop {
          height: 100vh;
          position: sticky;
          top: 0;
        }

        .sidebar-desktop::-webkit-scrollbar {
          width: 6px;
        }

        .sidebar-desktop::-webkit-scrollbar-track {
          background: #2c2c2c;
        }

        .sidebar-desktop::-webkit-scrollbar-thumb {
          background: #dc3545;
          border-radius: 3px;
        }

        .sidebar-desktop::-webkit-scrollbar-thumb:hover {
          background: #bd2130;
        }

        /* Sidebar nav item transitions */
        .sidebar-nav .list-group-item {
          transition: all 0.2s ease;
        }

        .sidebar-nav .list-group-item:hover {
          transform: translateX(4px);
        }

        /* Dispatcher header shadow */
        .dispatcher-header {
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        /* Offcanvas close button styling */
        .offcanvas-header .btn-close {
          filter: brightness(0) invert(1);
        }

        /* Dispatcher layout full height */
        .dispatcher-layout {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .dispatcher-content {
          flex-grow: 1;
        }

        /* Ensure sidebar content takes full height */
        .sidebar-content {
          height: 100%;
        }

        /* Remove any default margin/padding issues */
        .sidebar-nav {
          margin-bottom: 0;
        }

        /* Dark mode scrollbar for main content */
        .main-content::-webkit-scrollbar {
          width: 8px;
        }

        .main-content::-webkit-scrollbar-track {
          background: #1a1a2e;
        }

        .main-content::-webkit-scrollbar-thumb {
          background: #dc3545;
          border-radius: 4px;
        }

        /* Navbar dropdown dark mode */
        .dropdown-menu {
          background-color: #1a1a2e !important;
          border: 1px solid #2a2a4e !important;
        }

        .dropdown-item {
          color: #ffffff !important;
        }

        .dropdown-item:hover {
          background-color: #2a2a4e !important;
          color: #ffffff !important;
        }

        .dropdown-divider {
          border-top-color: #2a2a4e !important;
        }
      `}</style>
    </>
  );
};

export default MainLayout;