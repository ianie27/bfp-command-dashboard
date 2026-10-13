// src/pages/Incidents/index.tsx
import React, { useEffect, useState, useCallback } from 'react';
import {
  Card,
  Table,
  Badge,
  Button,
  Form,
  Row,
  Col,
  Modal,
  InputGroup,
  Container,
  Spinner,
  Pagination,
} from 'react-bootstrap';
import {
  FaSearch,
  FaEye,
  FaCheck,
  FaTimes,
  FaFire,
  FaFilter,
  FaChartLine,
  FaShieldAlt,
  FaCheckCircle,
  FaTrash,
  FaPhone,
  FaMapMarkerAlt,
  FaClock,
  FaUser,
  FaThermometerHalf,
  FaTint,
  FaWind,
} from 'react-icons/fa';
import {
  subscribeToIncidents,
  verifyIncident,
  deleteIncident,
} from '../../services/incidentService';
import { useAuth } from '../../hooks/useAuth';
import type { Incident } from '../../types';
import toast from 'react-hot-toast';

// ============================================================
// TERMINAL STATUSES — incidents that are no longer "active"
// ============================================================
const TERMINAL_STATUSES = ['Resolved', 'Cancelled', 'Dismissed', 'Ended'];

// ============================================================
// STATUS BADGE — covers every status the dispatcher can produce
// ============================================================
const getStatusBadge = (status: string): React.ReactElement => {
  const variants: Record<string, string> = {
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
  return (
    <Badge bg={variants[status] || 'secondary'} className="px-3 py-2 fw-bold">
      {status}
    </Badge>
  );
};

// ============================================================
// HELPER — get human-readable source label
// ============================================================
const getSourceLabel = (source?: string): string => {
  switch (source) {
    case 'citizen':
      return 'Citizen';
    case 'mobile_app':
      return 'Mobile App';
    case 'iot':
    case 'iot_sensor':
      return 'IoT Sensor';
    default:
      return source || 'Unknown';
  }
};

// ============================================================
// HELPER — check if incident source is IoT
// ============================================================
const isIotSource = (source?: string): boolean => {
  return source === 'iot' || source === 'iot_sensor';
};

// ============================================================
// HIGHLY VISIBLE CUSTOM CHECKBOX
// ============================================================
interface VisibleCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}

const VisibleCheckbox: React.FC<VisibleCheckboxProps> = ({
  checked,
  indeterminate = false,
  onChange,
  title,
}) => {
  const active = checked || indeterminate;
  return (
    <label
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        cursor: 'pointer',
        borderRadius: '6px',
        border: `2px solid ${active ? '#ff4757' : '#8b8b9e'}`,
        backgroundColor: active ? '#ff4757' : '#ffffff',
        boxShadow: active
          ? '0 0 0 3px rgba(255, 71, 87, 0.35), 0 0 10px rgba(255, 71, 87, 0.6)'
          : '0 0 0 1px rgba(0,0,0,0.1) inset',
        transition: 'all 0.15s ease-in-out',
        margin: 0,
        userSelect: 'none',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          position: 'absolute',
          opacity: 0,
          width: 0,
          height: 0,
          pointerEvents: 'none',
        }}
      />
      {checked && !indeterminate && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {indeterminate && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth="4"
          strokeLinecap="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      )}
    </label>
  );
};

const Incidents: React.FC = () => {
  const { user, logActivity } = useAuth();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [filteredIncidents, setFilteredIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [threatFilter, setThreatFilter] = useState<string>('ALL');
  const [showVerifyModal, setShowVerifyModal] = useState<boolean>(false);
  const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
  const [showViewModal, setShowViewModal] = useState<boolean>(false);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState<boolean>(false);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(
    null
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<boolean>(false);

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const itemsPerPage = 10;

  // ============================================================
  // FILTERS
  // ============================================================
  const applyFilters = useCallback(
    (data: Incident[], search: string, status: string, threat: string): void => {
      let filtered = [...data];

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(
          (inc) =>
            inc.incident_id.toLowerCase().includes(searchLower) ||
            (inc.location_address &&
              inc.location_address.toLowerCase().includes(searchLower)) ||
            (inc.caller_name &&
              inc.caller_name.toLowerCase().includes(searchLower)) ||
            (inc.caller_phone &&
              inc.caller_phone.toLowerCase().includes(searchLower))
        );
      }

      if (status !== 'ALL') {
        if (status === 'ACTIVE') {
          filtered = filtered.filter(
            (inc) => !TERMINAL_STATUSES.includes(inc.status)
          );
        } else {
          filtered = filtered.filter((inc) => inc.status === status);
        }
      }

      if (threat !== 'ALL') {
        filtered = filtered.filter((inc) => inc.threat_level === threat);
      }

      filtered.sort(
        (a, b) =>
          new Date(b.reported_at).getTime() -
          new Date(a.reported_at).getTime()
      );

      setFilteredIncidents(filtered);
      setCurrentPage(1); // Reset to page 1 on filter change
    },
    []
  );

  // ============================================================
  // REALTIME SUBSCRIPTION
  // ============================================================
  useEffect(() => {
    const unsubscribe = subscribeToIncidents((data) => {
      setIncidents(data);
      applyFilters(data, searchTerm, statusFilter, threatFilter);
      setLoading(false);
    });

    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFilters]);

  useEffect(() => {
    applyFilters(incidents, searchTerm, statusFilter, threatFilter);
  }, [incidents, searchTerm, statusFilter, threatFilter, applyFilters]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const visibleIds = new Set(filteredIncidents.map((i) => i.incident_id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (visibleIds.has(id)) next.add(id);
      });
      return next;
    });
  }, [filteredIncidents]);

  // ============================================================
  // PAGINATION LOGIC
  // ============================================================
  const totalPages = Math.ceil(filteredIncidents.length / itemsPerPage);
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentIncidents = filteredIncidents.slice(indexOfFirstItem, indexOfLastItem);

  // ============================================================
  // FILTER HANDLERS
  // ============================================================
  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearchTerm(e.target.value);
  };

  const handleStatusFilter = (
    e: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    setStatusFilter(e.target.value);
  };

  const handleThreatFilter = (
    e: React.ChangeEvent<HTMLSelectElement>
  ): void => {
    setThreatFilter(e.target.value);
  };

  const clearFilters = (): void => {
    setSearchTerm('');
    setStatusFilter('ALL');
    setThreatFilter('ALL');
    setCurrentPage(1);
  };

  // ============================================================
  // SELECTION HANDLERS
  // ============================================================
  const canDelete = user?.role === 'Administrator';
  const deletableIncidents = filteredIncidents;

  const allSelected =
    deletableIncidents.length > 0 &&
    deletableIncidents.every((inc) => selectedIds.has(inc.incident_id));

  const someSelected = selectedIds.size > 0 && !allSelected;

  const handleSelectAll = (checked: boolean): void => {
    if (checked) {
      setSelectedIds(new Set(deletableIncidents.map((i) => i.incident_id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (incidentId: string, checked: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(incidentId);
      } else {
        next.delete(incidentId);
      }
      return next;
    });
  };

  // ============================================================
  // ACTIONS
  // ============================================================
  const handleView = (incident: Incident): void => {
    setSelectedIncident(incident);
    setShowViewModal(true);
  };

  const handleVerify = async (): Promise<void> => {
    if (!selectedIncident || !user) return;

    setProcessing(true);
    try {
      await verifyIncident(
        selectedIncident.incident_id,
        user.personnel_id,
        user.displayName || user.full_name || user.username
      );
      await logActivity(
        'verify_incident',
        'incident',
        selectedIncident.incident_id
      );
      toast.success(`Incident ${selectedIncident.incident_id} verified`);
      setShowVerifyModal(false);
      setSelectedIncident(null);
    } catch (err) {
      console.error(err);
      toast.error('Failed to verify incident');
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!selectedIncident || !user) return;

    setProcessing(true);
    try {
      await deleteIncident(selectedIncident.incident_id);
      await logActivity(
        'delete_incident',
        'incident',
        selectedIncident.incident_id
      );
      toast.success(
        `Incident ${selectedIncident.incident_id} deleted successfully`
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(selectedIncident.incident_id);
        return next;
      });
      setShowDeleteModal(false);
      setSelectedIncident(null);
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete incident');
    } finally {
      setProcessing(false);
    }
  };

  const handleBulkDelete = async (): Promise<void> => {
    if (!user || selectedIds.size === 0) return;

    setProcessing(true);
    const ids = Array.from(selectedIds);
    let successCount = 0;
    let failCount = 0;

    try {
      for (const id of ids) {
        try {
          await deleteIncident(id);
          await logActivity('delete_incident', 'incident', id);
          successCount++;
        } catch (err) {
          console.error(`Failed to delete ${id}:`, err);
          failCount++;
        }
      }

      if (successCount > 0) {
        toast.success(
          `${successCount} incident${successCount > 1 ? 's' : ''} deleted${
            failCount > 0 ? `, ${failCount} failed` : ''
          }`
        );
      } else {
        toast.error('Failed to delete incidents');
      }

      setSelectedIds(new Set());
      setShowBulkDeleteModal(false);
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete incidents');
    } finally {
      setProcessing(false);
    }
  };

  // ============================================================
  // LOADING
  // ============================================================
  if (loading) {
    return (
      <div
        className="d-flex justify-content-center align-items-center"
        style={{ minHeight: '400px', backgroundColor: '#0f0f1a' }}
      >
        <Spinner animation="border" variant="danger" />
      </div>
    );
  }

  // ============================================================
  // STATS
  // ============================================================
  const activeCount = incidents.filter(
    (i) => !TERMINAL_STATUSES.includes(i.status)
  ).length;
  const resolvedCount = incidents.filter(
    (i) => i.status === 'Resolved'
  ).length;
  const verifiedCount = incidents.filter(
    (i) => i.verified_at || i.status === 'Verified'
  ).length;

  return (
    <div style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
      <Container fluid className="p-4">
        {/* ============================================================
            PAGE HEADER
            ============================================================ */}
        <div
          className="mb-4 pb-2 border-bottom"
          style={{ borderColor: '#2a2a4e' }}
        >
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-3">
            <div>
              <h2 className="text-white mb-1">
                <FaFire className="me-2 text-danger" />
                Incident Management
              </h2>
              <p style={{ color: '#a0a0a0' }} className="mb-0">
                View and manage all fire incidents in the system
              </p>
            </div>
          </div>
        </div>

        {/* ============================================================
            STATS CARDS
            ============================================================ */}
        <Row className="g-3 mb-4">
          <Col lg={3} md={6}>
            <Card
              className="text-center h-100 border-0"
              style={{
                background: '#1a1a2e',
                border: '1px solid #2a2a4e',
                borderRadius: '12px',
              }}
            >
              <Card.Body>
                <FaChartLine className="text-primary mb-2" size={24} />
                <h2
                  className="text-white fw-bold"
                  style={{ fontSize: '2rem' }}
                >
                  {incidents.length}
                </h2>
                <small style={{ color: '#a0a0a0' }}>Total Incidents</small>
              </Card.Body>
            </Card>
          </Col>
          <Col lg={3} md={6}>
            <Card
              className="text-center h-100 border-0"
              style={{
                background: '#1a1a2e',
                border: '1px solid #2a2a4e',
                borderRadius: '12px',
              }}
            >
              <Card.Body>
                <FaFire className="text-danger mb-2" size={24} />
                <h2
                  className="fw-bold"
                  style={{ color: '#ff6b6b', fontSize: '2rem' }}
                >
                  {activeCount}
                </h2>
                <small style={{ color: '#a0a0a0' }}>Active Incidents</small>
              </Card.Body>
            </Card>
          </Col>
          <Col lg={3} md={6}>
            <Card
              className="text-center h-100 border-0"
              style={{
                background: '#1a1a2e',
                border: '1px solid #2a2a4e',
                borderRadius: '12px',
              }}
            >
              <Card.Body>
                <FaShieldAlt className="text-info mb-2" size={24} />
                <h2
                  className="fw-bold"
                  style={{ color: '#4dd0e1', fontSize: '2rem' }}
                >
                  {verifiedCount}
                </h2>
                <small style={{ color: '#a0a0a0' }}>Verified</small>
              </Card.Body>
            </Card>
          </Col>
          <Col lg={3} md={6}>
            <Card
              className="text-center h-100 border-0"
              style={{
                background: '#1a1a2e',
                border: '1px solid #2a2a4e',
                borderRadius: '12px',
              }}
            >
              <Card.Body>
                <FaCheckCircle className="text-success mb-2" size={24} />
                <h2
                  className="fw-bold"
                  style={{ color: '#51cf66', fontSize: '2rem' }}
                >
                  {resolvedCount}
                </h2>
                <small style={{ color: '#a0a0a0' }}>Resolved</small>
              </Card.Body>
            </Card>
          </Col>
        </Row>

        {/* ============================================================
            FILTERS
            ============================================================ */}
        <Card
          className="mb-4 border-0"
          style={{
            backgroundColor: '#1a1a2e',
            border: '1px solid #2a2a4e',
            borderRadius: '12px',
          }}
        >
          <Card.Header
            style={{
              backgroundColor: '#0f0f1a',
              borderBottom: '2px solid #2a2a4e',
            }}
          >
            <div className="d-flex align-items-center">
              <FaFilter className="me-2 text-danger" />
              <h5 className="mb-0 text-white">Filter Incidents</h5>
            </div>
          </Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col lg={5}>
                <InputGroup>
                  <InputGroup.Text
                    style={{
                      backgroundColor: '#16213e',
                      borderColor: '#2a2a4e',
                      color: '#f8f9fa',
                    }}
                  >
                    <FaSearch />
                  </InputGroup.Text>
                  <Form.Control
                    type="text"
                    placeholder="Search by ID, location, or caller..."
                    value={searchTerm}
                    onChange={handleSearch}
                    style={{
                      backgroundColor: '#16213e',
                      borderColor: '#2a2a4e',
                      color: 'white',
                    }}
                  />
                </InputGroup>
              </Col>
              <Col lg={3}>
                <Form.Select
                  value={statusFilter}
                  onChange={handleStatusFilter}
                  style={{
                    backgroundColor: '#16213e',
                    borderColor: '#2a2a4e',
                    color: 'white',
                  }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ACTIVE">Active (In Progress)</option>
                  <option value="Verified">Verified</option>
                  <option value="Resolved">Resolved</option>
                </Form.Select>
              </Col>
              <Col lg={3}>
                <Form.Select
                  value={threatFilter}
                  onChange={handleThreatFilter}
                  style={{
                    backgroundColor: '#16213e',
                    borderColor: '#2a2a4e',
                    color: 'white',
                  }}
                >
                  <option value="ALL">All Threat Levels</option>
                  <option value="RED">🔴 High Threat (RED)</option>
                  <option value="YELLOW">🟡 Low Threat (YELLOW)</option>
                </Form.Select>
              </Col>
              <Col lg={1}>
                <Button
                  variant="outline-secondary"
                  className="w-100"
                  onClick={clearFilters}
                  style={{ borderColor: '#2a2a4e', color: 'white' }}
                >
                  <FaTimes /> Clear
                </Button>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* ============================================================
            BULK ACTIONS BAR
            ============================================================ */}
        {selectedIds.size > 0 && (
          <Card
            className="mb-3 border-0"
            style={{
              backgroundColor: '#2a1a1a',
              border: '1px solid #ff6b6b',
              borderRadius: '12px',
              boxShadow: '0 0 15px rgba(255, 107, 107, 0.35)',
            }}
          >
            <Card.Body className="py-2">
              <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
                <span className="text-white">
                  <strong style={{ color: '#ff6b6b', fontSize: '1.1rem' }}>
                    {selectedIds.size}
                  </strong>{' '}
                  incident
                  {selectedIds.size > 1 ? 's' : ''} selected
                </span>
                <div className="d-flex gap-2">
                  <Button
                    variant="outline-light"
                    size="sm"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    <FaTimes className="me-1" /> Clear Selection
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setShowBulkDeleteModal(true)}
                  >
                    <FaTrash className="me-1" /> Delete Selected (
                    {selectedIds.size})
                  </Button>
                </div>
              </div>
            </Card.Body>
          </Card>
        )}

        {/* ============================================================
            INCIDENTS TABLE
            ============================================================ */}
        <Card
          className="border-0"
          style={{
            backgroundColor: '#1a1a2e',
            border: '1px solid #2a2a4e',
            borderRadius: '12px',
          }}
        >
          <Card.Header
            className="d-flex justify-content-between align-items-center"
            style={{
              backgroundColor: '#0f0f1a',
              borderBottom: '2px solid #2a2a4e',
            }}
          >
            <div className="d-flex align-items-center">
              <FaFire className="me-2 text-danger" />
              <h5 className="mb-0 text-white">Incident List</h5>
            </div>
            <Badge bg="danger" className="px-3 py-2">
              {filteredIncidents.length} Incidents Found
            </Badge>
          </Card.Header>
          <div className="table-responsive">
            <Table hover className="mb-0" style={{ backgroundColor: 'white' }}>
              <thead style={{ backgroundColor: '#f8f9fa' }}>
                <tr>
                  {canDelete && (
                    <th
                      style={{
                        width: '60px',
                        textAlign: 'center',
                        verticalAlign: 'middle',
                      }}
                    >
                      <div className="d-flex flex-column align-items-center gap-1">
                        <VisibleCheckbox
                          checked={allSelected}
                          indeterminate={someSelected}
                          onChange={handleSelectAll}
                          title="Select all"
                        />
                        <small
                          style={{
                            fontSize: '9px',
                            color: '#6c757d',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                          }}
                        >
                          All
                        </small>
                      </div>
                    </th>
                  )}
                  <th className="fw-bold">Incident ID</th>
                  <th className="fw-bold">Threat</th>
                  <th className="fw-bold">Status</th>
                  <th className="fw-bold">Location / Contact</th>
                  <th className="fw-bold">Reported</th>
                  <th className="fw-bold">Source</th>
                  <th className="fw-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {currentIncidents.map((incident) => {
                  const isVerified = !!incident.verified_at;
                  const isActive = !TERMINAL_STATUSES.includes(incident.status);
                  const canVerify =
                    incident.status === 'Received' &&
                    (user?.role === 'Dispatcher' ||
                      user?.role === 'Administrator');
                  const isIot = isIotSource(incident.source);
                  const isChecked = selectedIds.has(incident.incident_id);

                  return (
                    <tr
                      key={incident.incident_id}
                      style={
                        isChecked
                          ? {
                              borderLeft: '4px solid #ff4757',
                              backgroundColor: '#ffe8ea',
                              boxShadow: 'inset 0 0 0 1px #ff4757',
                            }
                          : isActive
                          ? { borderLeft: '3px solid #ff6b6b' }
                          : undefined
                      }
                    >
                      {canDelete && (
                        <td
                          style={{
                            textAlign: 'center',
                            verticalAlign: 'middle',
                          }}
                        >
                          <VisibleCheckbox
                            checked={isChecked}
                            onChange={(checked) =>
                              handleSelectOne(incident.incident_id, checked)
                            }
                            title={`Select ${incident.incident_id}`}
                          />
                        </td>
                      )}
                      <td>
                        <strong className="text-danger">
                          {incident.incident_id}
                        </strong>
                        {isVerified && (
                          <FaShieldAlt
                            className="ms-2"
                            size={12}
                            style={{ color: '#17a2b8' }}
                            title={`Verified by ${
                              incident.verified_by_name || 'dispatcher'
                            }`}
                          />
                        )}
                      </td>
                      <td>
                        <Badge
                          bg={
                            incident.threat_level === 'RED'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {incident.threat_level || 'N/A'}
                        </Badge>
                      </td>
                      <td>{getStatusBadge(incident.status)}</td>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                          }}
                        >
                          <small>
                            {incident.location_address ||
                              `${incident.latitude.toFixed(
                                4
                              )}, ${incident.longitude.toFixed(4)}`}
                          </small>
                          {isIot ? (
                            (incident as any).owner_name && (
                              <small
                                style={{
                                  color: '#ffc107',
                                  fontWeight: 600,
                                }}
                              >
                                <FaUser size={10} className="me-1" />
                                {(incident as any).owner_name}
                                {(incident as any).owner_phone
                                  ? ` (${(incident as any).owner_phone})`
                                  : ''}
                              </small>
                            )
                          ) : (
                            incident.caller_name && (
                              <small
                                style={{
                                  color: '#17a2b8',
                                  fontWeight: 600,
                                }}
                              >
                                <FaPhone size={10} className="me-1" />
                                {incident.caller_name}
                                {incident.caller_phone
                                  ? ` (${incident.caller_phone})`
                                  : ''}
                              </small>
                            )
                          )}
                          {incident.emergency_id && (
                            <small style={{ color: '#6c757d' }}>
                              Emergency: {incident.emergency_id}
                            </small>
                          )}
                        </div>
                      </td>
                      <td>
                        <small>
                          {new Date(incident.reported_at).toLocaleString()}
                        </small>
                      </td>
                      <td>
                        <Badge bg="light" text="dark">
                          {getSourceLabel(incident.source)}
                        </Badge>
                      </td>
                      <td>
                        <div className="d-flex gap-2">
                          <Button
                            variant="outline-primary"
                            size="sm"
                            onClick={() => handleView(incident)}
                          >
                            <FaEye className="me-1" /> View
                          </Button>
                          {canVerify && (
                            <Button
                              variant="outline-success"
                              size="sm"
                              onClick={() => {
                                setSelectedIncident(incident);
                                setShowVerifyModal(true);
                              }}
                            >
                              <FaCheck /> Verify
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="outline-danger"
                              size="sm"
                              onClick={() => {
                                setSelectedIncident(incident);
                                setShowDeleteModal(true);
                              }}
                            >
                              <FaTrash /> Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filteredIncidents.length === 0 && (
                  <tr>
                    <td colSpan={canDelete ? 8 : 7} className="text-center py-5">
                      <div>
                        <FaFire
                          className="mb-2"
                          style={{ fontSize: '48px', opacity: 0.5 }}
                        />
                        <p className="mb-0">No incidents found</p>
                        <small className="text-muted">
                          Try adjusting your filters
                        </small>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
          
          {/* PAGINATION FOOTER */}
          {filteredIncidents.length > 0 && (
            <Card.Footer style={{ backgroundColor: '#f8f9fa', borderTop: '1px solid #dee2e6' }}>
              <div className="d-flex justify-content-between align-items-center">
                <small className="text-muted">
                  Showing {indexOfFirstItem + 1} to {Math.min(indexOfLastItem, filteredIncidents.length)} of {filteredIncidents.length} incidents
                </small>
                <Pagination size="sm" className="mb-0">
                  <Pagination.Prev 
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} 
                    disabled={currentPage === 1} 
                  />
                  {[...Array(totalPages)].map((_, i) => (
                    <Pagination.Item
                      key={i + 1}
                      active={i + 1 === currentPage}
                      onClick={() => setCurrentPage(i + 1)}
                    >
                      {i + 1}
                    </Pagination.Item>
                  ))}
                  <Pagination.Next 
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} 
                    disabled={currentPage === totalPages} 
                  />
                </Pagination>
              </div>
            </Card.Footer>
          )}
        </Card>

        {/* ============================================================
            VIEW MODAL
            ============================================================ */}
        <Modal
          show={showViewModal}
          onHide={() => {
            setShowViewModal(false);
            setSelectedIncident(null);
          }}
          centered
          size="lg"
        >
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>
              <FaEye className="me-2 text-primary" /> Incident Details
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark text-white">
            {selectedIncident && (
              <>
                <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
                  <h4 className="text-danger mb-0">
                    {selectedIncident.incident_id}
                  </h4>
                  <div className="d-flex gap-2">
                    <Badge
                      bg={
                        selectedIncident.threat_level === 'RED'
                          ? 'danger'
                          : 'warning'
                      }
                      className="px-3 py-2"
                    >
                      {selectedIncident.threat_level || 'N/A'} THREAT
                    </Badge>
                    {getStatusBadge(selectedIncident.status)}
                  </div>
                </div>

                <Row className="g-3">
                  <Col md={12}>
                    <div
                      className="border rounded p-3"
                      style={{
                        backgroundColor: '#16213e',
                        borderColor: '#2a2a4e',
                      }}
                    >
                      {isIotSource(selectedIncident.source) ? (
                        <>
                          <h6 className="text-warning mb-3">
                            <FaUser className="me-2" /> Owner Information
                          </h6>
                          <p className="mb-2">
                            <strong>Name:</strong>{' '}
                            {(selectedIncident as any).owner_name ||
                              'Unknown'}
                          </p>
                          <p className="mb-2">
                            <strong>Phone:</strong>{' '}
                            {(selectedIncident as any).owner_phone || 'N/A'}
                          </p>
                          <p className="mb-2">
                            <strong>Address:</strong>{' '}
                            {(selectedIncident as any).owner_address || 
                             selectedIncident.location_address || 
                             'Not specified'}
                          </p>
                          {(selectedIncident as any).owner_email && (
                            <p className="mb-2">
                              <strong>Email:</strong>{' '}
                              {(selectedIncident as any).owner_email}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <h6 className="text-info mb-3">
                            <FaPhone className="me-2" /> Caller Information
                          </h6>
                          <p className="mb-2">
                            <strong>Name:</strong>{' '}
                            {selectedIncident.caller_name || 'Unknown'}
                          </p>
                          <p className="mb-2">
                            <strong>Phone:</strong>{' '}
                            {selectedIncident.caller_phone || 'N/A'}
                          </p>
                          <p className="mb-2">
                            <strong>Address:</strong>{' '}
                            {selectedIncident.location_address || 'Not specified'}
                          </p>
                        </>
                      )}

                      <p className="mb-2">
                        <strong>Coordinates:</strong>{' '}
                        {selectedIncident.latitude?.toFixed(4)},{' '}
                        {selectedIncident.longitude?.toFixed(4)}
                      </p>
                    </div>
                  </Col>

                  <Col md={6}>
                    <div
                      className="border rounded p-3 h-100"
                      style={{
                        backgroundColor: '#16213e',
                        borderColor: '#2a2a4e',
                      }}
                    >
                      <h6 className="text-info mb-3">
                        <FaClock className="me-2" /> Timeline
                      </h6>
                      <p className="mb-2">
                        <strong>Reported:</strong>{' '}
                        {new Date(
                          selectedIncident.reported_at
                        ).toLocaleString()}
                      </p>
                      <p className="mb-2">
                        <strong>Verified:</strong>{' '}
                        {selectedIncident.verified_at
                          ? new Date(
                              selectedIncident.verified_at
                            ).toLocaleString()
                          : 'Not yet verified'}
                      </p>
                      <p className="mb-0">
                        <strong>Resolved:</strong>{' '}
                        {(selectedIncident as any).resolved_at
                          ? new Date(
                              (selectedIncident as any).resolved_at
                            ).toLocaleString()
                          : 'Not yet resolved'}
                      </p>
                    </div>
                  </Col>
                  <Col md={6}>
                    <div
                      className="border rounded p-3 h-100"
                      style={{
                        backgroundColor: '#16213e',
                        borderColor: '#2a2a4e',
                      }}
                    >
                      <h6 className="text-info mb-3">
                        <FaShieldAlt className="me-2" /> Source &amp; Meta
                      </h6>
                      <p className="mb-2">
                        <strong>Source:</strong>{' '}
                        {getSourceLabel(selectedIncident.source)}
                      </p>
                      {selectedIncident.emergency_id && (
                        <p className="mb-2">
                          <strong>Emergency ID:</strong>{' '}
                          {selectedIncident.emergency_id}
                        </p>
                      )}
                      {selectedIncident.verified_by_name && (
                        <p className="mb-0">
                          <strong>Verified by:</strong>{' '}
                          {selectedIncident.verified_by_name}
                        </p>
                      )}
                    </div>
                  </Col>

                  {/* DESCRIPTION & TELEMETRY */}
                  {(selectedIncident.description || isIotSource(selectedIncident.source)) && (
                    <Col md={12}>
                      <div
                        className="border rounded p-3"
                        style={{
                          backgroundColor: '#16213e',
                          borderColor: '#2a2a4e',
                        }}
                      >
                        <h6 className="text-info mb-2">Description &amp; Telemetry</h6>
                        {selectedIncident.description && (
                          <p className="mb-3">
                            {selectedIncident.description}
                          </p>
                        )}
                        
                        {isIotSource(selectedIncident.source) && (
                          <Row className="g-2 mt-2">
                            <Col md={3}>
                              <div className="p-2 rounded" style={{ backgroundColor: '#0f0f1a' }}>
                                <small className="text-muted d-block">Temperature</small>
                                <strong className="text-white">
                                  <FaThermometerHalf className="me-1 text-warning" />
                                  {(selectedIncident as any).temperature || 'N/A'}°C
                                </strong>
                              </div>
                            </Col>
                            <Col md={3}>
                              <div className="p-2 rounded" style={{ backgroundColor: '#0f0f1a' }}>
                                <small className="text-muted d-block">Humidity</small>
                                <strong className="text-white">
                                  <FaTint className="me-1 text-info" />
                                  {(selectedIncident as any).humidity || 'N/A'}%
                                </strong>
                              </div>
                            </Col>
                            <Col md={3}>
                              <div className="p-2 rounded" style={{ backgroundColor: '#0f0f1a' }}>
                                <small className="text-muted d-block">Fire Temp</small>
                                <strong className="text-white">
                                  <FaFire className="me-1 text-danger" />
                                  {(selectedIncident as any).fire_temperature || 'N/A'}°C
                                </strong>
                              </div>
                            </Col>
                            <Col md={3}>
                              <div className="p-2 rounded" style={{ backgroundColor: '#0f0f1a' }}>
                                <small className="text-muted d-block">Gas / Smoke</small>
                                <strong className="text-white">
                                  <FaWind className="me-1 text-secondary" />
                                  {(selectedIncident as any).gas_level || (selectedIncident as any).smoke_level || 'N/A'}
                                </strong>
                              </div>
                            </Col>
                          </Row>
                        )}
                      </div>
                    </Col>
                  )}
                </Row>
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button
              variant="secondary"
              onClick={() => {
                setShowViewModal(false);
                setSelectedIncident(null);
              }}
            >
              <FaTimes className="me-1" /> Close
            </Button>
          </Modal.Footer>
        </Modal>

        {/* ============================================================
            VERIFY MODAL
            ============================================================ */}
        <Modal
          show={showVerifyModal}
          onHide={() => setShowVerifyModal(false)}
          centered
        >
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>
              <FaCheck className="me-2 text-success" /> Verify Incident
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark text-white">
            <p>
              Are you sure you want to verify incident{' '}
              <strong>{selectedIncident?.incident_id}</strong>?
            </p>
            <p className="text-secondary">
              This will move the incident to the dispatch queue.
            </p>
            {selectedIncident && (
              <div
                className="border rounded p-3 mt-3"
                style={{
                  backgroundColor: '#16213e',
                  borderColor: '#2a2a4e',
                }}
              >
                <p className="mb-2">
                  <strong>📍 Location:</strong>{' '}
                  {selectedIncident.location_address || 'Not specified'}
                </p>
                <p className="mb-2">
                  <strong>⚠️ Threat Level:</strong>{' '}
                  {selectedIncident.threat_level}
                </p>
                <p className="mb-0">
                  <strong>🕐 Reported:</strong>{' '}
                  {new Date(selectedIncident.reported_at).toLocaleString()}
                </p>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button
              variant="secondary"
              onClick={() => setShowVerifyModal(false)}
            >
              <FaTimes className="me-1" /> Cancel
            </Button>
            <Button
              variant="success"
              onClick={handleVerify}
              disabled={processing}
            >
              {processing ? (
                'Verifying...'
              ) : (
                <>
                  <FaCheck className="me-1" /> Verify Incident
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal>

        {/* ============================================================
            DELETE MODAL (Single)
            ============================================================ */}
        <Modal
          show={showDeleteModal}
          onHide={() => setShowDeleteModal(false)}
          centered
        >
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>
              <FaTrash className="me-2 text-danger" /> Delete Incident
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark text-white">
            <p>
              Are you sure you want to delete incident{' '}
              <strong>{selectedIncident?.incident_id}</strong>?
            </p>
            <p className="text-danger">
              <strong>⚠️ Warning:</strong> This action cannot be undone!
            </p>
            {selectedIncident && (
              <div
                className="border rounded p-3 mt-3"
                style={{
                  backgroundColor: '#16213e',
                  borderColor: '#2a2a4e',
                }}
              >
                <p className="mb-2">
                  <strong>📍 Location:</strong>{' '}
                  {selectedIncident.location_address || 'Not specified'}
                </p>
                <p className="mb-2">
                  <strong>⚠️ Threat Level:</strong>{' '}
                  {selectedIncident.threat_level}
                </p>
                <p className="mb-2">
                  <strong>📊 Status:</strong> {selectedIncident.status}
                </p>
                <p className="mb-0">
                  <strong>🕐 Reported:</strong>{' '}
                  {new Date(selectedIncident.reported_at).toLocaleString()}
                </p>
              </div>
            )}
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button
              variant="secondary"
              onClick={() => setShowDeleteModal(false)}
            >
              <FaTimes className="me-1" /> Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={processing}
            >
              {processing ? (
                'Deleting...'
              ) : (
                <>
                  <FaTrash className="me-1" /> Delete Incident
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal>

        {/* ============================================================
            BULK DELETE MODAL
            ============================================================ */}
        <Modal
          show={showBulkDeleteModal}
          onHide={() => setShowBulkDeleteModal(false)}
          centered
        >
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>
              <FaTrash className="me-2 text-danger" /> Delete Selected
              Incidents
            </Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark text-white">
            <p>
              Are you sure you want to delete{' '}
              <strong>{selectedIds.size}</strong> selected incident
              {selectedIds.size > 1 ? 's' : ''}?
            </p>
            <p className="text-danger">
              <strong>⚠️ Warning:</strong> This action cannot be undone!
            </p>
            <div
              className="border rounded p-3 mt-3"
              style={{
                backgroundColor: '#16213e',
                borderColor: '#2a2a4e',
                maxHeight: '200px',
                overflowY: 'auto',
              }}
            >
              <h6 className="text-secondary mb-2">
                Incidents to delete:
              </h6>
              {filteredIncidents
                .filter((inc) => selectedIds.has(inc.incident_id))
                .map((inc) => (
                  <div
                    key={inc.incident_id}
                    className="d-flex justify-content-between align-items-center mb-1"
                  >
                    <span className="text-danger fw-bold">
                      {inc.incident_id}
                    </span>
                    <small className="text-secondary">
                      {inc.location_address || 'No address'}
                    </small>
                  </div>
                ))}
            </div>
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button
              variant="secondary"
              onClick={() => setShowBulkDeleteModal(false)}
              disabled={processing}
            >
              <FaTimes className="me-1" /> Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleBulkDelete}
              disabled={processing}
            >
              {processing ? (
                'Deleting...'
              ) : (
                <>
                  <FaTrash className="me-1" /> Delete {selectedIds.size}{' '}
                  Incident{selectedIds.size > 1 ? 's' : ''}
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </div>
  );
};

export default Incidents;