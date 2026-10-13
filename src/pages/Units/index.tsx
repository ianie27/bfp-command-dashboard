// ============================================
// UNITS PAGE - RESPONSE UNITS MANAGEMENT
// ============================================
// pages/Units/index.tsx
import React, { useEffect, useState, useCallback } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Badge,
  Button,
  Form,
  Modal,
  ListGroup,
  Container,
} from 'react-bootstrap';
import {
  FaTruck,
  FaSearch,
  FaEye,
  FaMapMarkerAlt,
  FaFilter,
  FaTimes,
  FaCheckCircle,
  FaExclamationTriangle,
} from 'react-icons/fa';
import { subscribeToUnits } from '../../services/unitService';
import type { ResponseUnit } from '../../types';

// ✅ Limit the page to only 2 units
const MAX_UNITS_TO_SHOW = 2;

const Units: React.FC = () => {
  const [units, setUnits] = useState<ResponseUnit[]>([]);
  const [filteredUnits, setFilteredUnits] = useState<ResponseUnit[]>([]);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [showDetailModal, setShowDetailModal] = useState<boolean>(false);
  const [selectedUnit, setSelectedUnit] = useState<ResponseUnit | null>(null);

  const applyFilters = useCallback((
    data: ResponseUnit[],
    search: string,
    status: string
  ): void => {
    let filtered = [...data];

    if (search) {
      filtered = filtered.filter(unit =>
        unit.unit_name.toLowerCase().includes(search.toLowerCase()) ||
        unit.unit_code.toLowerCase().includes(search.toLowerCase())
      );
    }

    if (status !== 'ALL') {
      filtered = filtered.filter(unit => unit.status === status);
    }

    setFilteredUnits(filtered);
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToUnits((data) => {
      // ✅ Only take the first 2 units from the collection
      const limitedUnits = data.slice(0, MAX_UNITS_TO_SHOW);

      setUnits(limitedUnits);
      applyFilters(limitedUnits, searchTerm, statusFilter);
    });

    return () => unsubscribe();
  }, [applyFilters, searchTerm, statusFilter]);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setSearchTerm(e.target.value);
    applyFilters(units, e.target.value, statusFilter);
  };

  const handleStatusFilter = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    setStatusFilter(e.target.value);
    applyFilters(units, searchTerm, e.target.value);
  };

  const getStatusBadge = (status: string): React.ReactElement => {
    const variants: Record<string, string> = {
      Available: 'success',
      Dispatched: 'primary',
      EnRoute: 'info',
      OnScene: 'warning',
    };
    return <Badge bg={variants[status] || 'secondary'}>{status}</Badge>;
  };

  const stats = {
    total: units.length,
    available: units.filter(u => u.status === 'Available').length,
    dispatched: units.filter(u => ['Dispatched', 'EnRoute', 'OnScene'].includes(u.status)).length,
  };

  return (
    <div style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
      <Container fluid className="p-4">
        {/* Page Header */}
        <div className="mb-4 pb-2 border-bottom border-secondary">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-3">
            <div>
              <h2 className="text-white mb-1">
                <FaTruck className="me-2 text-primary" />
                Response Units Management
              </h2>
              <p className="text-light-50 mb-0">Monitor and manage all emergency response units</p>
            </div>
            <div className="text-light">
              <small>Last updated: {new Date().toLocaleString()}</small>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="mb-4">
          <Row className="g-3">
            <Col lg={4} md={6}>
              <Card
                className="text-center h-100 border-0"
                style={{
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
                  border: '1px solid #2a2a4e',
                  borderRadius: '12px',
                  transition: 'transform 0.2s'
                }}
              >
                <Card.Body>
                  <FaTruck className="text-primary mb-2" size={24} />
                  <h2 style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '2rem' }}>{stats.total}</h2>
                  <small className="text-light">Total Units</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={4} md={6}>
              <Card
                className="text-center h-100 border-0"
                style={{
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
                  border: '1px solid #2a2a4e',
                  borderRadius: '12px'
                }}
              >
                <Card.Body>
                  <FaCheckCircle className="text-success mb-2" size={24} />
                  <h2 style={{ color: '#51cf66', fontWeight: 'bold', fontSize: '2rem' }}>{stats.available}</h2>
                  <small className="text-light">Available Units</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={4} md={6}>
              <Card
                className="text-center h-100 border-0"
                style={{
                  background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
                  border: '1px solid #2a2a4e',
                  borderRadius: '12px'
                }}
              >
                <Card.Body>
                  <FaExclamationTriangle className="text-warning mb-2" size={24} />
                  <h2 style={{ color: '#ffc107', fontWeight: 'bold', fontSize: '2rem' }}>{stats.dispatched}</h2>
                  <small className="text-light">Active/Dispatched</small>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </div>

        {/* Filters Section */}
        <Card className="mb-4 border-0" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
          <Card.Header style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
            <div className="d-flex align-items-center">
              <FaFilter className="me-2 text-primary" />
              <h5 className="mb-0 text-white">Filter Units</h5>
            </div>
          </Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col lg={7}>
                <div className="position-relative">
                  <FaSearch className="position-absolute" style={{ left: 12, top: 12, color: '#adb5bd' }} />
                  <Form.Control
                    type="text"
                    placeholder="Search units by name or code..."
                    value={searchTerm}
                    onChange={handleSearch}
                    style={{
                      paddingLeft: 35,
                      backgroundColor: '#16213e',
                      borderColor: '#2a2a4e',
                      color: 'white',
                      borderRadius: '8px'
                    }}
                  />
                </div>
              </Col>
              <Col lg={3}>
                <Form.Select
                  value={statusFilter}
                  onChange={handleStatusFilter}
                  style={{ backgroundColor: '#16213e', borderColor: '#2a2a4e', color: 'white', borderRadius: '8px' }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="Available">Available</option>
                  <option value="Dispatched">Dispatched</option>
                  <option value="EnRoute">En Route</option>
                  <option value="OnScene">On Scene</option>
                </Form.Select>
              </Col>
              <Col lg={2}>
                <Button
                  variant="outline-secondary"
                  className="w-100"
                  onClick={() => {
                    setSearchTerm('');
                    setStatusFilter('ALL');
                    applyFilters(units, '', 'ALL');
                  }}
                  style={{ borderColor: '#2a2a4e', color: 'white', borderRadius: '8px' }}
                >
                  <FaTimes className="me-1" /> Clear
                </Button>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Units Table */}
        <Card className="border-0" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
          <Card.Header className="d-flex justify-content-between align-items-center" style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
            <div className="d-flex align-items-center">
              <FaTruck className="me-2 text-primary" />
              <h5 className="mb-0 text-white">Unit Fleet Overview</h5>
            </div>
            <Badge bg="primary" className="px-3 py-2">
              {filteredUnits.length} Units Found
            </Badge>
          </Card.Header>
          <div className="table-responsive">
            <Table hover className="mb-0" style={{ backgroundColor: 'white', color: '#212529' }}>
              <thead style={{ backgroundColor: '#f8f9fa', color: '#212529' }}>
                <tr>
                  <th style={{ fontWeight: 'bold' }}>Unit</th>
                  <th style={{ fontWeight: 'bold' }}>Status</th>
                  <th style={{ fontWeight: 'bold' }}>Location</th>
                  <th style={{ fontWeight: 'bold' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUnits.map((unit) => (
                  <tr key={unit.unit_id} style={{ color: '#212529' }}>
                    <td style={{ verticalAlign: 'middle' }}>
                      <div className="d-flex align-items-center">
                        <div className="bg-light rounded-circle p-2 me-2" style={{ width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FaTruck className="text-primary" size={16} />
                        </div>
                        <div>
                          <strong style={{ color: '#212529' }}>{unit.unit_name}</strong>
                          <br />
                          <small className="text-secondary">{unit.unit_code}</small>
                        </div>
                      </div>
                    </td>
                    <td style={{ verticalAlign: 'middle' }}>{getStatusBadge(unit.status)}</td>
                    <td style={{ verticalAlign: 'middle' }}>
                      <small>
                        <FaMapMarkerAlt className="me-1 text-muted" />
                        {unit.latitude.toFixed(4)}, {unit.longitude.toFixed(4)}
                      </small>
                    </td>
                    <td style={{ verticalAlign: 'middle' }}>
                      <div className="d-flex gap-2">
                        <Button
                          variant="outline-primary"
                          size="sm"
                          onClick={() => {
                            setSelectedUnit(unit);
                            setShowDetailModal(true);
                          }}
                        >
                          <FaEye className="me-1" /> View
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredUnits.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center py-5">
                      <div className="text-black">
                        <FaTruck className="mb-2" style={{ fontSize: '48px', opacity: 0.5, color: '#000' }} />
                        <p className="mb-0" style={{ color: '#000' }}>No units found</p>
                        <small style={{ color: '#000' }}>Try adjusting your filters</small>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
          {filteredUnits.length > 0 && (
            <Card.Footer style={{ backgroundColor: '#f8f9fa', borderTop: '1px solid #dee2e6' }}>
              <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
                <small className="text-muted">
                  Showing {filteredUnits.length} of {units.length} total units
                </small>
                <div className="d-flex gap-3">
                  <small className="text-muted">
                    <span className="text-success">●</span> Available: {stats.available}
                  </small>
                  <small className="text-muted">
                    <span className="text-warning">●</span> Active: {stats.dispatched}
                  </small>
                </div>
              </div>
            </Card.Footer>
          )}
        </Card>

        {/* Unit Detail Modal */}
        <Modal show={showDetailModal} onHide={() => setShowDetailModal(false)} size="lg" centered>
          <Modal.Header closeButton style={{ backgroundColor: '#1a1a2e', color: 'white', borderBottom: '1px solid #2a2a4e' }}>
            <Modal.Title style={{ color: 'white' }}>
              <FaTruck className="me-2 text-primary" />
              {selectedUnit?.unit_name} ({selectedUnit?.unit_code})
            </Modal.Title>
          </Modal.Header>
          {selectedUnit && (
            <Modal.Body style={{ backgroundColor: '#1a1a2e', color: '#f8f9fa' }}>
              <Row>
                <Col md={12}>
                  <div className="mb-3">
                    <h6 className="text-primary mb-3">
                      <FaTruck className="me-2" /> Unit Information
                    </h6>
                    <ListGroup className="mb-3">
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Status:</strong> {getStatusBadge(selectedUnit.status)}
                      </ListGroup.Item>
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Current Location:</strong>
                        <br />
                        <small>Lat: {selectedUnit.latitude.toFixed(6)}</small>
                        <br />
                        <small>Lng: {selectedUnit.longitude.toFixed(6)}</small>
                      </ListGroup.Item>
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Last Update:</strong>
                        <br />
                        {new Date(selectedUnit.last_update).toLocaleString()}
                      </ListGroup.Item>
                    </ListGroup>
                  </div>
                </Col>
              </Row>
            </Modal.Body>
          )}
          <Modal.Footer style={{ backgroundColor: '#1a1a2e', borderTop: '1px solid #2a2a4e' }}>
            <Button variant="secondary" onClick={() => setShowDetailModal(false)}>
              Close
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </div>
  );
};

export default Units;