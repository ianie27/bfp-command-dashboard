// src/pages/IncidentDetail/IncidentDetails.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Card,
  Row,
  Col,
  Badge,
  Button,
  ListGroup,
  Table,
  Modal,
  Form,
  Spinner,
  Alert,
  Container,
} from 'react-bootstrap';
import {
  FaArrowLeft,
  FaMapMarkerAlt,
  FaUser,
  FaTruck,
  FaCheck,
  FaHistory,
  FaMicrochip,
} from 'react-icons/fa';
import {
  subscribeToIncident,
  subscribeToIncidentHistory,
  verifyIncident,
  dispatchUnits,
  updateIncidentStatus,
} from '../../services/incidentService';
import { subscribeToUnits } from '../../services/unitService';
import { useAuth } from '../../hooks/useAuth';
import type { Incident, IncidentStatusHistory, ResponseUnit } from '../../types';
import toast from 'react-hot-toast';

type IncidentStatus = 'Received' | 'Verified' | 'Dispatched' | 'EnRoute' | 'OnScene' | 'Resolved' | 'Cancelled';

const IncidentDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, logActivity } = useAuth();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [history, setHistory] = useState<IncidentStatusHistory[]>([]);
  const [units, setUnits] = useState<ResponseUnit[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [showDispatchModal, setShowDispatchModal] = useState<boolean>(false);
  const [showStatusModal, setShowStatusModal] = useState<boolean>(false);
  const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
  const [newStatus, setNewStatus] = useState<string>('');
  const [statusNotes, setStatusNotes] = useState<string>('');
  const [processing, setProcessing] = useState<boolean>(false);

  useEffect(() => {
    if (!id) return;

    const unsubIncident = subscribeToIncident(id, (data) => {
      setIncident(data);
      setLoading(false);
    });

    const unsubHistory = subscribeToIncidentHistory(id, (data) => {
      setHistory(data);
    });

    const unsubUnits = subscribeToUnits((data) => {
      setUnits(data);
    });

    return () => {
      unsubIncident();
      unsubHistory();
      unsubUnits();
    };
  }, [id]);

  const handleVerify = async (): Promise<void> => {
    if (!incident || !user) return;

    setProcessing(true);
    try {
      await verifyIncident(incident.incident_id, user.personnel_id);
      await logActivity('verify_incident', 'incident', incident.incident_id);
      toast.success('Incident verified successfully');
    } catch {
      toast.error('Failed to verify incident');
    } finally {
      setProcessing(false);
    }
  };

  const handleDispatch = async (): Promise<void> => {
    if (!incident || !user || selectedUnits.length === 0) return;

    setProcessing(true);
    try {
      await dispatchUnits(incident.incident_id, selectedUnits, user.personnel_id);
      await logActivity('dispatch_units', 'incident', incident.incident_id);
      toast.success(`${selectedUnits.length} unit(s) dispatched`);
      setShowDispatchModal(false);
      setSelectedUnits([]);
    } catch {
      toast.error('Failed to dispatch units');
    } finally {
      setProcessing(false);
    }
  };

  const handleStatusUpdate = async (): Promise<void> => {
    if (!incident || !user || !newStatus) return;

    setProcessing(true);
    try {
      await updateIncidentStatus(
        incident.incident_id,
        newStatus as IncidentStatus,
        user.personnel_id,
        incident.status as IncidentStatus,
        statusNotes
      );
      await logActivity('update_incident_status', 'incident', incident.incident_id);
      toast.success(`Status updated to ${newStatus}`);
      setShowStatusModal(false);
      setNewStatus('');
      setStatusNotes('');
    } catch {
      toast.error('Failed to update status');
    } finally {
      setProcessing(false);
    }
  };

  const getAvailableStatusTransitions = (currentStatus: string): string[] => {
    const transitions: Record<string, string[]> = {
      Received: ['Verified', 'Cancelled'],
      Verified: ['Dispatched', 'Cancelled'],
      Dispatched: ['EnRoute', 'Cancelled'],
      EnRoute: ['OnScene', 'Cancelled'],
      OnScene: ['Resolved'],
    };
    return transitions[currentStatus] || [];
  };

  const getStatusColor = (status: string): string => {
    const colors: Record<string, string> = {
      Received: 'secondary',
      Verified: 'info',
      Dispatched: 'primary',
      EnRoute: 'info',
      OnScene: 'warning',
      Resolved: 'success',
      Cancelled: 'danger',
    };
    return colors[status] || 'secondary';
  };

  const availableUnits = units.filter(u => u.status === 'Available');
  const assignedUnits = units.filter(u => u.assigned_incident_id === incident?.incident_id);

  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '400px', backgroundColor: '#0f0f1a' }}>
        <Spinner animation="border" variant="danger" />
      </div>
    );
  }

  if (!incident) {
    return (
      <Container fluid className="p-4" style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
        <Alert variant="danger">
          Incident not found. <Link to="/incidents">Return to incidents list</Link>
        </Alert>
      </Container>
    );
  }

  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  return (
    <div style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
      <Container fluid className="p-4">
        <div className="d-flex align-items-center mb-4">
          <Button variant="outline-secondary" onClick={() => navigate(-1)} className="me-3">
            <FaArrowLeft /> Back
          </Button>
          <div>
            <h2 className="text-white mb-0">
              Incident {incident.incident_id}
              <Badge bg={incident.threat_level === 'RED' ? 'danger' : 'warning'} className="ms-3">
                {incident.threat_level} THREAT
              </Badge>
            </h2>
            <p style={{ color: '#a0a0a0' }} className="mb-0">
              Reported: {new Date(incident.reported_at).toLocaleString()}
            </p>
          </div>
          <div className="ms-auto">
            <Badge bg={getStatusColor(incident.status)} className="p-2 fs-6">
              {incident.status}
            </Badge>
          </div>
        </div>

        <Row className="g-3">
          <Col lg={8}>
            <Card className="mb-3" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e' }}>
              <Card.Header className="bg-dark text-white">Incident Information</Card.Header>
              <Card.Body>
                <Row>
                  <Col md={6}>
                    <p className="text-white"><FaMapMarkerAlt className="me-2 text-danger" /><strong>Location:</strong></p>
                    <p className="ms-4" style={{ color: '#a0a0a0' }}>
                      {incident.location_address || `${incident.latitude}, ${incident.longitude}`}
                    </p>
                    <p className="text-white"><FaUser className="me-2 text-primary" /><strong>Reported By:</strong></p>
                    <p className="ms-4" style={{ color: '#a0a0a0' }}>
                      {incident.source === 'citizen' ? '📱 Citizen User' : '🤖 IoT Sensor'}
                    </p>
                  </Col>
                  <Col md={6}>
                    <p className="text-white"><FaMicrochip className="me-2 text-success" /><strong>IoT Sensor:</strong></p>
                    <p className="ms-4" style={{ color: '#a0a0a0' }}>
                      {incident.iot_sensor_id || 'N/A'}
                    </p>
                    {incident.description && (
                      <>
                        <p className="text-white"><strong>Description:</strong></p>
                        <p className="ms-4" style={{ color: '#a0a0a0' }}>{incident.description}</p>
                      </>
                    )}
                  </Col>
                </Row>
              </Card.Body>
            </Card>

            <Card className="mb-3" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e' }}>
              <Card.Header className="bg-dark text-white">Response Timeline</Card.Header>
              <Card.Body>
                <div className="timeline">
                  <div className="timeline-item">
                    <div className="d-flex">
                      <div className="timeline-marker bg-secondary"></div>
                      <div className="flex-grow-1">
                        <strong className="text-white">Received</strong>
                        <br />
                        <small style={{ color: '#a0a0a0' }}>{new Date(incident.reported_at).toLocaleString()}</small>
                      </div>
                    </div>
                  </div>
                  {incident.verified_at && (
                    <div className="timeline-item">
                      <div className="d-flex">
                        <div className="timeline-marker bg-info"></div>
                        <div className="flex-grow-1">
                          <strong className="text-white">Verified</strong>
                          <br />
                          <small style={{ color: '#a0a0a0' }}>{new Date(incident.verified_at).toLocaleString()}</small>
                        </div>
                      </div>
                    </div>
                  )}
                  {incident.dispatched_at && (
                    <div className="timeline-item">
                      <div className="d-flex">
                        <div className="timeline-marker bg-primary"></div>
                        <div className="flex-grow-1">
                          <strong className="text-white">Dispatched</strong>
                          <br />
                          <small style={{ color: '#a0a0a0' }}>{new Date(incident.dispatched_at).toLocaleString()}</small>
                        </div>
                      </div>
                    </div>
                  )}
                  {incident.resolved_at && (
                    <div className="timeline-item">
                      <div className="d-flex">
                        <div className="timeline-marker bg-success"></div>
                        <div className="flex-grow-1">
                          <strong className="text-white">Resolved</strong>
                          <br />
                          <small style={{ color: '#a0a0a0' }}>{new Date(incident.resolved_at).toLocaleString()}</small>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </Card.Body>
            </Card>

            <Card style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e' }}>
              <Card.Body>
                <div className="d-flex flex-wrap gap-2">
                  {incident.status === 'Received' && user?.role === 'Dispatcher' && (
                    <Button variant="success" onClick={handleVerify} disabled={processing}>
                      <FaCheck className="me-2" /> Verify Incident
                    </Button>
                  )}
                  {(incident.status === 'Verified' || incident.status === 'Dispatched') && user?.role === 'Dispatcher' && (
                    <Button variant="primary" onClick={() => setShowDispatchModal(true)} disabled={processing}>
                      <FaTruck className="me-2" /> Dispatch Units
                    </Button>
                  )}
                  {!['Resolved', 'Cancelled'].includes(incident.status) && (
                    <Button variant="outline-primary" onClick={() => setShowStatusModal(true)} disabled={processing}>
                      <FaHistory className="me-2" /> Update Status
                    </Button>
                  )}
                  <Button
                    variant="outline-secondary"
                    onClick={() => window.open(`https://maps.google.com/?q=${incident.latitude},${incident.longitude}`, '_blank')}
                  >
                    <FaMapMarkerAlt className="me-2" /> Open in Maps
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </Col>

          <Col lg={4}>
            {assignedUnits.length > 0 && (
              <Card className="mb-3" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e' }}>
                <Card.Header className="bg-dark text-white">
                  <FaTruck className="me-2" /> Assigned Units
                </Card.Header>
                <ListGroup variant="flush">
                  {assignedUnits.map(unit => (
                    <ListGroup.Item key={unit.unit_id} style={{ backgroundColor: '#1a1a2e', color: '#ffffff', borderColor: '#2a2a4e' }}>
                      <div className="d-flex justify-content-between align-items-start">
                        <div>
                          <strong>{unit.unit_name}</strong>
                          <br />
                          <small style={{ color: '#a0a0a0' }}>{unit.unit_code}</small>
                        </div>
                        <Badge bg={unit.status === 'EnRoute' ? 'info' : unit.status === 'OnScene' ? 'warning' : 'primary'}>
                          {unit.status}
                        </Badge>
                      </div>
                    </ListGroup.Item>
                  ))}
                </ListGroup>
              </Card>
            )}

            <Card style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e' }}>
              <Card.Header className="bg-dark text-white">
                <FaHistory className="me-2" /> Status History
              </Card.Header>
              <ListGroup variant="flush" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {history.slice(0, 10).map((entry) => (
                  <ListGroup.Item key={entry.history_id} style={{ backgroundColor: '#1a1a2e', color: '#ffffff', borderColor: '#2a2a4e' }}>
                    <div className="d-flex justify-content-between">
                      <span>
                        <Badge bg={getStatusColor(entry.status_from)} className="me-2">
                          {entry.status_from}
                        </Badge>
                        →
                        <Badge bg={getStatusColor(entry.status_to)} className="ms-2">
                          {entry.status_to}
                        </Badge>
                      </span>
                      <small style={{ color: '#a0a0a0' }}>{new Date(entry.updated_at).toLocaleTimeString()}</small>
                    </div>
                    <small style={{ color: '#a0a0a0' }}>By: {entry.updated_by}</small>
                    {entry.notes && <p className="mt-1 mb-0 small" style={{ color: '#a0a0a0' }}>{entry.notes}</p>}
                  </ListGroup.Item>
                ))}
              </ListGroup>
            </Card>
          </Col>
        </Row>

        {/* Dispatch Modal */}
        <Modal show={showDispatchModal} onHide={() => setShowDispatchModal(false)} size="lg" centered>
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>Dispatch Response Units</Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark">
            <p className="text-white">Select units to dispatch to incident <strong>{incident.incident_id}</strong></p>
            <Table hover className="mb-0" style={{ backgroundColor: 'white' }}>
              <thead style={{ backgroundColor: '#f8f9fa' }}>
                <tr>
                  <th>
                    <Form.Check
                      type="checkbox"
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedUnits(availableUnits.map(u => u.unit_id));
                        } else {
                          setSelectedUnits([]);
                        }
                      }}
                      checked={selectedUnits.length === availableUnits.length && availableUnits.length > 0}
                    />
                  </th>
                  <th>Unit</th>
                  <th>Status</th>
                  <th>Distance</th>
                  <th>ETA</th>
                </tr>
              </thead>
              <tbody>
                {availableUnits.map(unit => {
                  const distance = calculateDistance(
                    incident.latitude, incident.longitude,
                    unit.latitude, unit.longitude
                  );
                  const eta = Math.round((distance / 40) * 60);
                  return (
                    <tr key={unit.unit_id}>
                      <td>
                        <Form.Check
                          type="checkbox"
                          checked={selectedUnits.includes(unit.unit_id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedUnits([...selectedUnits, unit.unit_id]);
                            } else {
                              setSelectedUnits(selectedUnits.filter(id => id !== unit.unit_id));
                            }
                          }}
                        />
                      </td>
                      <td>
                        <strong>{unit.unit_name}</strong>
                        <br />
                        <small>{unit.unit_code}</small>
                      </td>
                      <td><Badge bg="success">{unit.status}</Badge></td>
                      <td>{distance.toFixed(2)} km</td>
                      <td>~{eta} min</td>
                    </tr>
                  );
                })}
                {availableUnits.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-muted py-3">No available units</td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button variant="secondary" onClick={() => setShowDispatchModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleDispatch} disabled={selectedUnits.length === 0 || processing}>
              {processing ? <Spinner animation="border" size="sm" className="me-2" /> : <FaTruck className="me-2" />}
              Dispatch ({selectedUnits.length})
            </Button>
          </Modal.Footer>
        </Modal>

        {/* Status Update Modal */}
        <Modal show={showStatusModal} onHide={() => setShowStatusModal(false)} centered>
          <Modal.Header closeButton className="bg-dark text-white">
            <Modal.Title>Update Incident Status</Modal.Title>
          </Modal.Header>
          <Modal.Body className="bg-dark">
            <Form.Group className="mb-3">
              <Form.Label className="text-white">Current Status: <Badge bg={getStatusColor(incident.status)}>{incident.status}</Badge></Form.Label>
            </Form.Group>
            <Form.Group className="mb-3">
              <Form.Label className="text-white">New Status</Form.Label>
              <Form.Select
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
                style={{ backgroundColor: '#16213e', borderColor: '#2a2a4e', color: 'white' }}
              >
                <option value="">Select new status...</option>
                {getAvailableStatusTransitions(incident.status).map(status => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </Form.Select>
            </Form.Group>
            <Form.Group>
              <Form.Label className="text-white">Notes (Optional)</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                value={statusNotes}
                onChange={(e) => setStatusNotes(e.target.value)}
                placeholder="Add any additional notes..."
                style={{ backgroundColor: '#16213e', borderColor: '#2a2a4e', color: 'white' }}
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer className="bg-dark">
            <Button variant="secondary" onClick={() => setShowStatusModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleStatusUpdate} disabled={!newStatus || processing}>
              {processing ? 'Updating...' : 'Update Status'}
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </div>
  );
};

export default IncidentDetail;