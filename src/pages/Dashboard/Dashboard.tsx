// src/pages/Dashboard/Dashboard.tsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Row, Col, Card, Badge, ListGroup, Button } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import {
  FaFire,
  FaTruck,
  FaClock,
  FaExclamationTriangle,
  FaCheckCircle,
  FaMicrochip,
  FaChartPie,
  FaNetworkWired,
  FaShieldAlt
} from 'react-icons/fa';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  type ChartData
} from 'chart.js';
import { Pie, Bar } from 'react-chartjs-2';
import { subscribeToIncidents } from '../../services/incidentService';
import { subscribeToUnits } from '../../services/unitService';
import { subscribeToSensors } from '../../services/sensorService';
import type { Incident, ResponseUnit, IoTSensor, DashboardStats } from '../../types';

// Register ChartJS components
ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
  Title
);

// ============================================
// ✅ LIMIT DASHBOARD TO SAME 2 UNITS AS UNITS PAGE
// ============================================
const MAX_UNITS_TO_SHOW = 2;

// Shared color tokens
const COLORS = {
  card: '#1a1a2e',
  bg: '#0f0f1a',
  border: '#2a2a4e',
  text: '#ffffff',
  muted: '#a0a0a0',
};

// ============================================
// UTILITY FUNCTION TO PREVENT SIDEBAR TRIGGER
// ============================================
const preventSidebarTrigger = (e: React.MouseEvent | React.TouchEvent | React.WheelEvent) => {
  e.stopPropagation();
  e.nativeEvent?.stopImmediatePropagation();
};

// ============================================
// STATS CARD COMPONENT - DARK MODE
// ============================================
interface StatsCardProps {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  badge?: { text: string; color: string };
  subText?: string;
}

const StatsCard: React.FC<StatsCardProps> = ({ title, value, icon, color, badge, subText }) => (
  <Card
    className="h-100 border-0 shadow-sm"
    style={{ backgroundColor: COLORS.card }}
    onMouseEnter={preventSidebarTrigger}
    onMouseLeave={preventSidebarTrigger}
    onClick={preventSidebarTrigger}
    onWheel={preventSidebarTrigger}
  >
    <Card.Body className="p-3">
      <div className="d-flex align-items-center gap-3">
        <div
          className={`bg-${color} bg-opacity-10 text-${color} rounded-circle d-flex align-items-center justify-content-center flex-shrink-0`}
          style={{ width: '38px', height: '38px' }}
        >
          {icon}
        </div>
        <div className="flex-grow-1 overflow-hidden">
          <div className="fw-bold" style={{ fontSize: '1.3rem', color: COLORS.text, lineHeight: 1.1 }}>
            {value.toLocaleString()}
          </div>
          <small style={{ fontSize: '0.7rem', color: COLORS.muted }}>{title}</small>
        </div>
      </div>
      {(badge || subText) && (
        <div className="mt-2 d-flex align-items-center gap-2 flex-wrap">
          {badge && (
            <Badge bg={badge.color} style={{ fontSize: '0.65rem' }}>
              {badge.text}
            </Badge>
          )}
          {subText && (
            <small style={{ fontSize: '0.65rem', color: COLORS.muted }}>{subText}</small>
          )}
        </div>
      )}
    </Card.Body>
  </Card>
);

// ============================================
// SECTION HEADER COMPONENT - DARK MODE
// ============================================
interface SectionHeaderProps {
  title: string;
  icon: React.ReactNode;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({ title, icon }) => (
  <div
    className="d-flex align-items-center gap-2 mb-3"
    onClick={preventSidebarTrigger}
    onMouseEnter={preventSidebarTrigger}
  >
    <div style={{ fontSize: '1rem', color: '#dc3545' }}>{icon}</div>
    <h6 className="mb-0 fw-semibold" style={{ color: COLORS.text, fontSize: '0.9rem' }}>
      {title}
    </h6>
  </div>
);

// ============================================
// STATS GRID COMPONENT
// ============================================
interface StatsGridProps {
  stats: DashboardStats;
  totalIncidents: number;
}

const StatsGrid: React.FC<StatsGridProps> = ({ stats, totalIncidents }) => (
  <Row
    className="g-3 mb-3"
    onClick={preventSidebarTrigger}
    onMouseEnter={preventSidebarTrigger}
    onWheel={preventSidebarTrigger}
  >
    <Col xl={3} lg={6} md={6}>
      <StatsCard
        title="Total Incidents"
        value={totalIncidents}
        icon={<FaFire size={18} />}
        color="danger"
        badge={{ text: `${stats.totalActiveIncidents} Active`, color: 'danger' }}
      />
    </Col>
    <Col xl={3} lg={6} md={6}>
      <StatsCard
        title="Available Units"
        value={stats.availableUnits}
        icon={<FaTruck size={18} />}
        color="primary"
        badge={{ text: `${stats.dispatchedUnits} Dispatched`, color: 'primary' }}
      />
    </Col>
    <Col xl={3} lg={6} md={6}>
      <StatsCard
        title="Avg Response Time"
        value={stats.averageResponseTime}
        icon={<FaClock size={18} />}
        color="warning"
        subText={`Today: ${stats.incidentsToday} incidents`}
      />
    </Col>
    <Col xl={3} lg={6} md={6}>
      <StatsCard
        title="Sensors Online"
        value={stats.sensorsOnline}
        icon={<FaMicrochip size={18} />}
        color="success"
        badge={{ text: `${stats.sensorsOffline} Offline`, color: 'secondary' }}
      />
    </Col>
  </Row>
);

// ============================================
// CHARTS SECTION COMPONENT - DARK MODE
// ============================================
interface ChartsSectionProps {
  threatLevelData: ChartData<'pie', number[], string>;
  unitStatusData: ChartData<'bar', number[], string>;
  stats: DashboardStats;
  sensors: IoTSensor[];
}

const ChartsSection: React.FC<ChartsSectionProps> = ({
  threatLevelData,
  unitStatusData,
  stats,
  sensors,
}) => {
  const pieOptions = {
    maintainAspectRatio: true,
    plugins: {
      legend: { display: false },
      tooltip: {
        bodyFont: { size: 11 },
        titleFont: { size: 11, weight: 'bold' as const },
      },
    },
  };

  const barOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false, labels: { color: COLORS.text } },
      tooltip: {
        bodyFont: { size: 11 },
        titleFont: { size: 11, weight: 'bold' as const },
      },
    },
    scales: {
      x: {
        ticks: { font: { size: 10, weight: 'bold' as const }, color: COLORS.text },
        title: {
          display: true,
          text: 'Unit Status',
          color: COLORS.muted,
          font: { size: 10 },
        },
      },
      y: {
        ticks: { font: { size: 10 }, color: COLORS.text },
        title: {
          display: true,
          text: 'Units',
          color: COLORS.muted,
          font: { size: 10 },
        },
        beginAtZero: true,
      },
    },
  };

  const statBlock = (icon: React.ReactNode, value: number, label: string) => (
    <div className="d-flex flex-column align-items-center justify-content-center py-2">
      {icon}
      <div className="fw-bold" style={{ color: COLORS.text, fontSize: '1.35rem', lineHeight: 1.1 }}>
        {value}
      </div>
      <small
        className="text-uppercase"
        style={{ color: COLORS.muted, letterSpacing: '0.5px', fontSize: '0.65rem' }}
      >
        {label}
      </small>
    </div>
  );

  return (
    <div className="mb-3">
      <SectionHeader title="Analytics Overview" icon={<FaChartPie size={16} />} />
      <Row className="g-3">
        {/* --- Threat Level --- */}
        <Col xl={4} lg={12} md={12}>
          <Card className="h-100 border-0 shadow-sm" style={{ backgroundColor: COLORS.card }}>
            <Card.Body className="p-3 d-flex flex-column">
              <div className="d-flex align-items-center gap-2 mb-2">
                <div
                  className="rounded-circle d-flex align-items-center justify-content-center"
                  style={{ width: '32px', height: '32px', backgroundColor: 'rgba(220,53,69,0.15)' }}
                >
                  <FaExclamationTriangle className="text-danger" size={15} />
                </div>
                <h6 className="mb-0 fw-semibold" style={{ color: COLORS.text, fontSize: '0.85rem' }}>
                  Threat Level Distribution
                </h6>
              </div>

              <div
                className="d-flex justify-content-center align-items-center flex-grow-1"
                style={{ minHeight: '150px' }}
              >
                <div style={{ height: '150px', width: '150px' }}>
                  <Pie data={threatLevelData} options={pieOptions} />
                </div>
              </div>

              <Row className="g-0 w-100 text-center mt-2">
                <Col xs={6} style={{ borderRight: `1px solid ${COLORS.border}` }}>
                  {statBlock(
                    <FaExclamationTriangle className="text-danger mb-1" size={16} />,
                    stats.highThreatIncidents,
                    'High Threat'
                  )}
                </Col>
                <Col xs={6}>
                  {statBlock(
                    <FaExclamationTriangle className="text-warning mb-1" size={16} />,
                    stats.totalActiveIncidents - stats.highThreatIncidents,
                    'Low Threat'
                  )}
                </Col>
              </Row>
            </Card.Body>
          </Card>
        </Col>

        {/* --- Unit Status --- */}
        <Col xl={4} lg={6} md={12}>
          <Card className="h-100 border-0 shadow-sm" style={{ backgroundColor: COLORS.card }}>
            <Card.Body className="p-3 d-flex flex-column">
              <div className="d-flex align-items-center gap-2 mb-2">
                <div
                  className="rounded-circle d-flex align-items-center justify-content-center"
                  style={{ width: '32px', height: '32px', backgroundColor: 'rgba(0,123,255,0.15)' }}
                >
                  <FaTruck className="text-primary" size={15} />
                </div>
                <h6 className="mb-0 fw-semibold" style={{ color: COLORS.text, fontSize: '0.85rem' }}>
                  Unit Status Overview
                </h6>
              </div>
              <div className="flex-grow-1" style={{ minHeight: '220px' }}>
                <Bar data={unitStatusData} options={barOptions} />
              </div>
            </Card.Body>
          </Card>
        </Col>

        {/* --- Sensor Network --- */}
        <Col xl={4} lg={6} md={12}>
          <Card className="h-100 border-0 shadow-sm" style={{ backgroundColor: COLORS.card }}>
            <Card.Body className="p-3 d-flex flex-column">
              <div className="d-flex align-items-center gap-2 mb-2">
                <div
                  className="rounded-circle d-flex align-items-center justify-content-center"
                  style={{ width: '32px', height: '32px', backgroundColor: 'rgba(40,167,69,0.15)' }}
                >
                  <FaNetworkWired className="text-success" size={15} />
                </div>
                <h6 className="mb-0 fw-semibold" style={{ color: COLORS.text, fontSize: '0.85rem' }}>
                  Sensor Network Health
                </h6>
              </div>

              <div className="d-flex align-items-center flex-grow-1" style={{ minHeight: '220px' }}>
                <Row className="g-0 w-100 text-center">
                  <Col xs={4}>
                    {statBlock(<FaMicrochip className="text-success mb-1" size={20} />, stats.sensorsOnline, 'Online')}
                  </Col>
                  <Col
                    xs={4}
                    style={{
                      borderLeft: `1px solid ${COLORS.border}`,
                      borderRight: `1px solid ${COLORS.border}`,
                    }}
                  >
                    {statBlock(<FaMicrochip className="text-danger mb-1" size={20} />, stats.sensorsOffline, 'Offline')}
                  </Col>
                  <Col xs={4}>
                    {statBlock(<FaMicrochip className="text-secondary mb-1" size={20} />, sensors.length, 'Total')}
                  </Col>
                </Row>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

// ============================================
// INCIDENTS TABLE COMPONENT - DARK MODE
// Shows ALL incidents (not just active)
// ============================================
interface IncidentsTableProps {
  incidents: Incident[];
}

const IncidentsTable: React.FC<IncidentsTableProps> = ({ incidents }) => {
  const allIncidents = [...incidents].sort(
    (a, b) => new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime()
  );

  const openGoogleMaps = (latitude: number, longitude: number, incidentId: string) => {
    const url = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}&query_place_id=${incidentId}`;
    window.open(url, '_blank');
  };

  const getStatusBadgeColor = (status: string): string => {
    const colors: Record<string, string> = {
      Received: 'secondary',
      Verified: 'info',
      Acknowledged: 'success',
      Connected: 'success',
      Dispatched: 'primary',
      EnRoute: 'info',
      OnScene: 'warning',
      Resolved: 'success',
      Cancelled: 'danger',
      Ended: 'dark',
      Dismissed: 'secondary',
    };
    return colors[status] || 'secondary';
  };

  return (
    <Card className="h-100 border-0 shadow-sm" style={{ backgroundColor: COLORS.card }}>
      <Card.Header
        className="pt-3 pb-0 px-3"
        style={{ backgroundColor: COLORS.card, borderBottomColor: COLORS.border }}
      >
        <SectionHeader
          title={`All Incidents (${allIncidents.length})`}
          icon={<FaFire size={14} />}
        />
      </Card.Header>
      <Card.Body className="pt-0 px-3 pb-3">
        <ListGroup variant="flush">
          {allIncidents.slice(0, 5).map((incident) => (
            <ListGroup.Item
              key={incident.incident_id}
              className="px-0 py-2"
              style={{ backgroundColor: 'transparent', borderBottomColor: COLORS.border }}
              onClick={preventSidebarTrigger}
            >
              <div className="d-flex justify-content-between align-items-center gap-3">
                <div className="flex-grow-1 overflow-hidden">
                  <div className="d-flex align-items-center flex-wrap gap-2 mb-1">
                    <Badge bg={incident.threat_level === 'RED' ? 'danger' : 'warning'}>
                      {incident.threat_level}
                    </Badge>
                    <Badge bg={getStatusBadgeColor(incident.status)}>{incident.status}</Badge>
                    <strong style={{ color: COLORS.text, fontSize: '0.85rem' }}>
                      {incident.incident_id}
                    </strong>
                  </div>
                  <div
                    className="text-truncate"
                    style={{ color: COLORS.muted, fontSize: '0.75rem' }}
                  >
                    {incident.location_address ||
                      `${incident.latitude.toFixed(2)}, ${incident.longitude.toFixed(2)}`}
                    <span className="ms-2">
                      • {new Date(incident.reported_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                <Button
                  variant="outline-danger"
                  size="sm"
                  style={{ fontSize: '0.7rem', whiteSpace: 'nowrap' }}
                  onClick={(e) => {
                    preventSidebarTrigger(e);
                    e.stopPropagation();
                    openGoogleMaps(incident.latitude, incident.longitude, incident.incident_id);
                  }}
                >
                  View Location
                </Button>
              </div>
            </ListGroup.Item>
          ))}

          {allIncidents.length === 0 && (
            <div className="text-center py-4">
              <FaCheckCircle className="text-success mb-2" size={26} />
              <p className="mb-0" style={{ color: COLORS.text, fontSize: '0.9rem' }}>
                No incidents recorded
              </p>
              <small style={{ color: COLORS.muted }}>System is clear</small>
            </div>
          )}
        </ListGroup>

        {allIncidents.length > 5 && (
          <div className="text-center mt-3">
            <Link
              to="/incidents"
              className="btn btn-outline-danger btn-sm"
              style={{ fontSize: '0.75rem' }}
              onClick={preventSidebarTrigger}
            >
              View All {allIncidents.length} Incidents
            </Link>
          </div>
        )}
      </Card.Body>
    </Card>
  );
};

// ============================================
// LIVE CLOCK COMPONENT
// ============================================
const LiveClock: React.FC = () => {
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="text-end">
      <Badge bg="success" className="px-2 py-1" style={{ fontSize: '0.65rem' }}>
        <span
          className="d-inline-block rounded-circle bg-white me-1"
          style={{ width: '6px', height: '6px', animation: 'pulse 1.5s infinite' }}
        ></span>
        LIVE
      </Badge>
      <div className="mt-1">
        <small style={{ color: COLORS.muted, fontSize: '0.7rem' }}>
          {currentTime.toLocaleDateString()} • {currentTime.toLocaleTimeString()}
        </small>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
};

// ============================================
// DASHBOARD HEADER COMPONENT - DARK MODE
// ============================================
const DashboardHeader: React.FC = () => (
  <div
    className="d-flex justify-content-between align-items-center mb-3 pb-2 border-bottom"
    style={{ borderBottomColor: COLORS.border }}
  >
    <div className="d-flex align-items-center gap-2">
      <FaShieldAlt size={24} className="text-danger" />
      <h5 className="mb-0 fw-bold" style={{ color: COLORS.text }}>
        Command Dashboard
      </h5>
    </div>
    <LiveClock />
  </div>
);

// ============================================
// MAIN DASHBOARD COMPONENT - DARK MODE
// ============================================
const Dashboard: React.FC = () => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [units, setUnits] = useState<ResponseUnit[]>([]);
  const [sensors, setSensors] = useState<IoTSensor[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalActiveIncidents: 0,
    highThreatIncidents: 0,
    availableUnits: 0,
    dispatchedUnits: 0,
    averageResponseTime: 0,
    sensorsOnline: 0,
    sensorsOffline: 0,
    incidentsToday: 0,
    incidentsThisWeek: 0,
  });

  const dashboardRef = useRef<HTMLDivElement>(null);

  const calculateStats = useCallback(
    (incidentsData: Incident[], unitsData: ResponseUnit[], sensorsData: IoTSensor[]): void => {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const activeIncidents = incidentsData.filter(
        (inc) => !['Resolved', 'Cancelled'].includes(inc.status)
      );
      const todayIncidents = incidentsData.filter((inc) => new Date(inc.reported_at) >= today);
      const weekIncidents = incidentsData.filter((inc) => new Date(inc.reported_at) >= weekAgo);

      const responseTimes = incidentsData
        .filter((inc) => inc.response_time_seconds)
        .map((inc) => inc.response_time_seconds as number);

      const avgResponseTime =
        responseTimes.length > 0
          ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          : 0;

      setStats({
        totalActiveIncidents: activeIncidents.length,
        highThreatIncidents: activeIncidents.filter((inc) => inc.threat_level === 'RED').length,
        availableUnits: unitsData.filter((u) => u.status === 'Available').length,
        dispatchedUnits: unitsData.filter((u) =>
          ['Dispatched', 'EnRoute', 'OnScene'].includes(u.status)
        ).length,
        averageResponseTime: Math.round(avgResponseTime / 60),
        sensorsOnline: sensorsData.filter((s) => s.status === 'Active').length,
        sensorsOffline: sensorsData.filter((s) => s.status === 'Offline').length,
        incidentsToday: todayIncidents.length,
        incidentsThisWeek: weekIncidents.length,
      });
    },
    []
  );

  useEffect(() => {
    let currentIncidents: Incident[] = [];
    let currentUnits: ResponseUnit[] = [];
    let currentSensors: IoTSensor[] = [];

    const unsubIncidents = subscribeToIncidents((data) => {
      currentIncidents = data;
      setIncidents(data);
      calculateStats(data, currentUnits, currentSensors);
    });

    const unsubUnits = subscribeToUnits((data) => {
      const limitedUnits = data.slice(0, MAX_UNITS_TO_SHOW);
      currentUnits = limitedUnits;
      setUnits(limitedUnits);
      calculateStats(currentIncidents, limitedUnits, currentSensors);
    });

    const unsubSensors = subscribeToSensors((data) => {
      currentSensors = data;
      setSensors(data);
      calculateStats(currentIncidents, currentUnits, data);
    });

    return () => {
      unsubIncidents();
      unsubUnits();
      unsubSensors();
    };
  }, [calculateStats]);

  const threatLevelData = {
    labels: ['High Threat (RED)', 'Low Threat (YELLOW)'],
    datasets: [
      {
        data: [
          stats.highThreatIncidents,
          stats.totalActiveIncidents - stats.highThreatIncidents,
        ],
        backgroundColor: ['#dc3545', '#ffc107'],
        borderWidth: 0,
      },
    ],
  };

  const unitStatusData = {
    labels: ['Available', 'Dispatched', 'En Route', 'On Scene'],
    datasets: [
      {
        label: 'Units',
        data: [
          units.filter((u) => u.status === 'Available').length,
          units.filter((u) => u.status === 'Dispatched').length,
          units.filter((u) => u.status === 'EnRoute').length,
          units.filter((u) => u.status === 'OnScene').length,
        ],
        backgroundColor: ['#28a745', '#007bff', '#17a2b8', '#fd7e14'],
        borderRadius: 4,
      },
    ],
  };

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => e.stopPropagation();

  return (
    <div
      ref={dashboardRef}
      className="dashboard p-3"
      style={{
        overflowY: 'auto',
        overflowX: 'hidden',
        height: '100%',
        minHeight: '100vh',
        backgroundColor: COLORS.bg,
      }}
      onClick={preventSidebarTrigger}
      onMouseEnter={preventSidebarTrigger}
      onWheel={preventSidebarTrigger}
      onScroll={handleScroll}
    >
      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        <DashboardHeader />
        <StatsGrid stats={stats} totalIncidents={incidents.length} />
        <ChartsSection
          threatLevelData={threatLevelData}
          unitStatusData={unitStatusData}
          stats={stats}
          sensors={sensors}
        />
        <Row className="g-3">
          <Col xs={12}>
            <IncidentsTable incidents={incidents} />
          </Col>
        </Row>
      </div>
    </div>
  );
};

export default Dashboard;