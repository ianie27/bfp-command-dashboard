import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Card,
  Row,
  Col,
  Badge,
  Button,
  Form,
  Alert,
  Modal,
  ListGroup,
  Container,
  Spinner,
} from 'react-bootstrap';
import {
  FaMicrochip,
  FaSearch,
  FaExclamationTriangle,
  FaMapMarkerAlt,
  FaClock,
  FaFire,
  FaThermometerHalf,
  FaFilter,
  FaTimes,
  FaChartLine,
  FaCheckCircle,
  FaPlus,
  FaCrosshairs,
  FaSave,
  FaTrash,
} from 'react-icons/fa';

import {
  firestore,
  doc,
  setDoc,
  deleteDoc,
} from '../../services/firebase/firebase';

import { subscribeToSensors, subscribeToSensorReadings } from '../../services/sensorService';
import type { IoTSensor, SensorReading } from '../../types';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

// ─────────────────────────────────────────────────────────────
// Map Picker (Leaflet loaded via CDN)
// ─────────────────────────────────────────────────────────────
interface MapPickerProps {
  latitude: number;
  longitude: number;
  onChange: (lat: number, lng: number) => void;
  height?: number;
}

const MapPicker: React.FC<MapPickerProps> = ({ latitude, longitude, onChange, height = 280 }) => {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [leafletReady, setLeafletReady] = useState<boolean>(false);
  const [leafletFailed, setLeafletFailed] = useState<boolean>(false);

  useEffect(() => {
    if ((window as any).L) {
      setLeafletReady(true);
      return;
    }
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link');
      link.id = 'leaflet-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.async = true;
    script.onload = () => setLeafletReady(true);
    script.onerror = () => setLeafletFailed(true);
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    if (!leafletReady || !mapRef.current || leafletMapRef.current) return;
    const L = (window as any).L;
    if (!L) return;

    const initLat = isNaN(latitude) ? 20.5937 : latitude;
    const initLng = isNaN(longitude) ? 78.9629 : longitude;

    const map = L.map(mapRef.current, {
      center: [initLat, initLng],
      zoom: latitude && longitude ? 16 : 4,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const marker = L.marker([initLat, initLng], { draggable: true }).addTo(map);

    marker.on('dragend', (e: any) => {
      const pos = e.target.getLatLng();
      onChange(pos.lat, pos.lng);
    });

    map.on('click', (e: any) => {
      const { lat, lng } = e.latlng;
      marker.setLatLng([lat, lng]);
      onChange(lat, lng);
    });

    leafletMapRef.current = map;
    markerRef.current = marker;

    setTimeout(() => map.invalidateSize(), 250);

    return () => {
      map.remove();
      leafletMapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leafletReady]);

  useEffect(() => {
    if (!leafletMapRef.current || !markerRef.current) return;
    if (isNaN(latitude) || isNaN(longitude)) return;
    markerRef.current.setLatLng([latitude, longitude]);
    leafletMapRef.current.setView([latitude, longitude], 16);
  }, [latitude, longitude]);

  if (leafletFailed) {
    const bbox = `${(isNaN(longitude) ? 0 : longitude) - 0.01}%2C${(isNaN(latitude) ? 0 : latitude) - 0.01}%2C${(isNaN(longitude) ? 0 : longitude) + 0.01}%2C${(isNaN(latitude) ? 0 : latitude) + 0.01}`;
    return (
      <div>
        <div style={{ height, borderRadius: 8, overflow: 'hidden', border: '1px solid #2a2a4e' }}>
          <iframe
            title="Sensor Location"
            width="100%"
            height={height}
            frameBorder="0"
            style={{ border: 0 }}
            src={`https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude}%2C${longitude}`}
          />
        </div>
        <small className="text-warning d-block mt-2">
          Interactive map unavailable. Enter coordinates manually.
        </small>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={mapRef}
        style={{
          height,
          width: '100%',
          borderRadius: 8,
          border: '1px solid #2a2a4e',
          backgroundColor: '#16213e',
        }}
      />
      <small className="text-secondary d-block mt-2">
        💡 Click on the map or drag the marker to set the sensor location.
      </small>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Form state — sensor_type removed
// ─────────────────────────────────────────────────────────────
interface NewSensorForm {
  sensor_id: string;
  name: string;
  phone: string;
  address: string;
  floor: string;
  room: string;
  latitude: string;
  longitude: string;
}

const emptyForm: NewSensorForm = {
  sensor_id: '',
  name: '',
  phone: '',
  address: '',
  floor: '',
  room: '',
  latitude: '',
  longitude: '',
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const safeFixed = (v: unknown, digits = 6): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : 'N/A';
};

const safeCoord = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────
const Sensors: React.FC = () => {
  const [sensors, setSensors] = useState<IoTSensor[]>([]);
  const [filteredSensors, setFilteredSensors] = useState<IoTSensor[]>([]);
  const [readings, setReadings] = useState<Record<string, SensorReading[]>>({});
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedSensor, setSelectedSensor] = useState<IoTSensor | null>(null);

  // Add/Edit modal state
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [newSensor, setNewSensor] = useState<NewSensorForm>(emptyForm);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [locating, setLocating] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState<boolean>(false);

  // Delete modal state
  const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
  const [sensorToDelete, setSensorToDelete] = useState<IoTSensor | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState<string>('');
  const [deleting, setDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const existingIds = useMemo(
    () => new Set(sensors.map((s) => s.sensor_id)),
    [sensors]
  );

  const applyFilters = useCallback((
    data: IoTSensor[],
    search: string,
    status: string
  ): void => {
    let filtered = [...data];

    if (search) {
      filtered = filtered.filter(sensor =>
        sensor.sensor_id.toLowerCase().includes(search.toLowerCase()) ||
        (sensor.location || '').toLowerCase().includes(search.toLowerCase())
      );
    }
    if (status !== 'ALL') filtered = filtered.filter(s => s.status === status);

    setFilteredSensors(filtered);
  }, []);

  useEffect(() => {
    const unsubSensors = subscribeToSensors((data) => {
      setSensors(data);
      setSelectedSensor(prev => {
        if (!prev) return prev;
        const fresh = data.find(s => s.sensor_id === prev.sensor_id);
        return fresh || prev;
      });
    });
    return () => unsubSensors();
  }, []);

  useEffect(() => {
    applyFilters(sensors, searchTerm, statusFilter);
  }, [sensors, searchTerm, statusFilter, applyFilters]);

  const sensorIdsKey = useMemo(
    () => sensors.map(s => s.sensor_id).sort().join('|'),
    [sensors]
  );

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    const ids = sensorIdsKey ? sensorIdsKey.split('|') : [];
    ids.forEach((id) => {
      const unsubscribe = subscribeToSensorReadings(id, (data) => {
        setReadings(prev => ({ ...prev, [id]: data.slice(-20) }));
      });
      unsubscribers.push(unsubscribe);
    });
    return () => unsubscribers.forEach(unsub => unsub());
  }, [sensorIdsKey]);

  const getStatusBadge = (status: string): React.ReactElement => {
    const variants: Record<string, string> = {
      Active: 'success',
      Maintenance: 'warning',
      Offline: 'danger',
    };
    return <Badge bg={variants[status] || 'secondary'}>{status}</Badge>;
  };

  const getSensorTypeIcon = (type: string): React.ReactElement | string => {
    switch (type) {
      case 'Smoke': return '💨';
      case 'Heat': return <FaThermometerHalf />;
      case 'Flame': return <FaFire />;
      default: return <FaMicrochip />;
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>): void =>
    setSearchTerm(e.target.value);

  const handleStatusFilterChange = (e: React.ChangeEvent<HTMLSelectElement>): void =>
    setStatusFilter(e.target.value);

  const handleCloseModal = (): void => setSelectedSensor(null);

  const stats = {
    total: sensors.length,
    active: sensors.filter(s => s.status === 'Active').length,
    offline: sensors.filter(s => s.status === 'Offline').length,
  };

  const getChartData = (sensorId: string) => {
    const sensorReadings = readings[sensorId] || [];
    return {
      labels: sensorReadings.map(r => new Date(r.read_at).toLocaleTimeString()),
      datasets: [
        {
          label: 'Smoke (PPM)',
          data: sensorReadings.map(r => r.smoke_ppm || 0),
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.3,
          yAxisID: 'y',
        },
        {
          label: 'Temperature (°C)',
          data: sensorReadings.map(r => r.temperature || 0),
          borderColor: 'rgb(53, 162, 235)',
          backgroundColor: 'rgba(53, 162, 235, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.3,
          yAxisID: 'y1',
        },
      ],
    };
  };

  // ── Add / Edit handlers ────────────────────────────────────
  const openAddModal = (): void => {
    setNewSensor(emptyForm);
    setFormErrors({});
    setSaveSuccess(null);
    setIsEditing(false);
    setShowAddModal(true);
  };

  const openEditModal = (sensor: IoTSensor): void => {
    setNewSensor({
      sensor_id: sensor.sensor_id,
      name: (sensor as any).admin_name || (sensor as any).name || '',
      phone: (sensor as any).admin_phone || (sensor as any).phone || '',
      address: (sensor as any).admin_address || '',
      floor: (sensor as any).floor || '',
      room: (sensor as any).room || '',
      latitude: String(sensor.latitude ?? ''),
      longitude: String(sensor.longitude ?? ''),
    });
    setFormErrors({});
    setSaveSuccess(null);
    setIsEditing(true);
    setShowAddModal(true);
    setSelectedSensor(null);
  };

  const closeAddModal = (): void => {
    setShowAddModal(false);
    setNewSensor(emptyForm);
    setFormErrors({});
    setSaveSuccess(null);
    setIsEditing(false);
  };

  const handleFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ): void => {
    const { name, value } = e.target;
    setNewSensor(prev => ({ ...prev, [name]: value }));
    if (formErrors[name]) {
      setFormErrors(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const handleMapChange = (lat: number, lng: number): void => {
    setNewSensor(prev => ({
      ...prev,
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
    }));
  };

  const useMyLocation = (): void => {
    if (!navigator.geolocation) {
      setFormErrors(prev => ({ ...prev, latitude: 'Geolocation is not supported.' }));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setNewSensor(prev => ({
          ...prev,
          latitude: position.coords.latitude.toFixed(6),
          longitude: position.coords.longitude.toFixed(6),
        }));
        setLocating(false);
      },
      (error) => {
        setLocating(false);
        let msg = 'Unable to retrieve your location.';
        if (error.code === error.PERMISSION_DENIED) msg = 'Location permission denied.';
        if (error.code === error.POSITION_UNAVAILABLE) msg = 'Location information unavailable.';
        if (error.code === error.TIMEOUT) msg = 'Location request timed out.';
        setFormErrors(prev => ({ ...prev, latitude: msg }));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    const sid = newSensor.sensor_id.trim();
    if (!sid) errors.sensor_id = 'Sensor ID is required.';
    else if (!/^[A-Za-z0-9_\-]{2,}$/.test(sid))
      errors.sensor_id = 'Use letters, digits, dash or underscore (e.g. SENSOR_01).';
    else if (existingIds.has(sid) && !isEditing)
      errors.sensor_id = `Sensor "${sid}" already exists. Use a unique ID or click an existing sensor to edit.`;

    if (!newSensor.name.trim()) errors.name = 'Owner name is required.';
    if (!newSensor.phone.trim()) errors.phone = 'Phone number is required.';
    else if (!/^[+\d][\d\s\-()]{6,}$/.test(newSensor.phone.trim()))
      errors.phone = 'Enter a valid phone number.';

    if (!newSensor.floor.trim()) errors.floor = 'Floor is required.';
    if (!newSensor.room.trim()) errors.room = 'Room is required.';

    const lat = parseFloat(newSensor.latitude);
    const lng = parseFloat(newSensor.longitude);
    if (!newSensor.latitude || isNaN(lat) || lat < -90 || lat > 90)
      errors.latitude = 'Latitude must be between -90 and 90.';
    if (!newSensor.longitude || isNaN(lng) || lng < -180 || lng > 180)
      errors.longitude = 'Longitude must be between -180 and 180.';

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSaveSensor = async (): Promise<void> => {
    if (!validateForm()) return;

    setSaving(true);
    setSaveSuccess(null);
    try {
      const lat = parseFloat(newSensor.latitude);
      const lng = parseFloat(newSensor.longitude);
      const now = new Date().toISOString();
      const sensorId = newSensor.sensor_id.trim();

      const composedLocation = `${newSensor.floor.trim()}, ${newSensor.room.trim()}`;
      const composedAddress =
        newSensor.address.trim() ||
        `Del Castillo Boarding House, ${composedLocation}`;

      const sensorPayload: Record<string, any> = {
        sensor_id: sensorId,
        sensor_type: 'fire_gas_sensor',
        status: 'Active',

        location: composedLocation,
        location_name: composedLocation,
        building: 'Del Castillo Boarding House',
        room: newSensor.room.trim(),
        floor: newSensor.floor.trim(),
        latitude: lat,
        longitude: lng,

        admin_name: newSensor.name.trim(),
        admin_phone: newSensor.phone.trim(),
        admin_email: '',
        admin_address: composedAddress,
        admin_role: '',
        admin_emergency: '',

        battery_level: 100,
        accuracy: 10,
        provider: 'manual_fixed',

        installed_at: now,
        last_heartbeat: now,
        created_at: now,
        updated_at: now,
      };

      const ref = doc(firestore, 'iot_sensors', sensorId);
      await setDoc(ref, sensorPayload, { merge: true });

      setSaveSuccess(
        `Sensor "${sensorId}" saved. Live readings will appear as soon as the ESP32 sends telemetry.`
      );
      setTimeout(() => closeAddModal(), 2000);
    } catch (err: any) {
      console.error('Failed to save sensor:', err);
      const code = err?.code ? `[${err.code}] ` : '';
      setFormErrors(prev => ({
        ...prev,
        _global: `${code}${err?.message || 'Failed to save sensor.'} — check Firestore rules.`,
      }));
    } finally {
      setSaving(false);
    }
  };

  // ── Delete handlers ────────────────────────────────────────
  const openDeleteModal = (sensor: IoTSensor): void => {
    setSensorToDelete(sensor);
    setDeleteConfirmText('');
    setDeleteError(null);
    setShowDeleteModal(true);
  };

  const closeDeleteModal = (): void => {
    setShowDeleteModal(false);
    setSensorToDelete(null);
    setDeleteConfirmText('');
    setDeleteError(null);
  };

  const handleDeleteSensor = async (): Promise<void> => {
    if (!sensorToDelete) return;
    if (deleteConfirmText.trim() !== sensorToDelete.sensor_id) {
      setDeleteError(`Please type "${sensorToDelete.sensor_id}" exactly to confirm.`);
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDoc(doc(firestore, 'iot_sensors', sensorToDelete.sensor_id));

      setSensors(prev => prev.filter(s => s.sensor_id !== sensorToDelete.sensor_id));
      setFilteredSensors(prev => prev.filter(s => s.sensor_id !== sensorToDelete.sensor_id));
      setSelectedSensor(null);

      closeDeleteModal();
    } catch (err: any) {
      console.error('Failed to delete sensor:', err);
      const code = err?.code ? `[${err.code}] ` : '';
      setDeleteError(
        `${code}${err?.message || 'Failed to delete sensor.'} — only Administrators can delete. Check bfp_personnel/{uid}.role.`
      );
    } finally {
      setDeleting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: '#16213e',
    borderColor: '#2a2a4e',
    color: 'white',
    borderRadius: '8px',
  };
  const labelStyle: React.CSSProperties = { color: '#adb5bd', fontSize: '0.85rem' };

  return (
    <div style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
      <Container fluid className="p-4">
        {/* Page Header */}
        <div className="mb-4 pb-2 border-bottom border-secondary">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-3">
            <div>
              <h2 className="text-white mb-1">
                <FaMicrochip className="me-2 text-success" /> IoT Sensor Monitoring
              </h2>
              <p className="text-light-50 mb-0">Monitor all deployed fire detection sensors in real-time</p>
            </div>
            <div className="d-flex align-items-center gap-3">
              <div className="text-light">
                <small>Last updated: {new Date().toLocaleString()}</small>
              </div>
              <Button
                variant="success"
                onClick={openAddModal}
                style={{ borderRadius: '8px', display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <FaPlus /> Add Sensor
              </Button>
            </div>
          </div>
        </div>

        {stats.offline > 0 && (
          <div className="mb-4">
            <Alert variant="danger" className="d-flex align-items-center mb-2" style={{ borderRadius: '12px' }}>
              <FaExclamationTriangle className="me-3" size={20} />
              <strong>{stats.offline} sensor(s) are offline!</strong>
              <span className="ms-2">Please check network connectivity.</span>
            </Alert>
          </div>
        )}

        {/* Stats */}
        <div className="mb-4">
          <Row className="g-3 justify-content-center">
            <Col lg={3} md={4} sm={6}>
              <Card className="text-center h-100 border-0" style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <FaMicrochip className="text-primary mb-2" size={24} />
                  <h2 style={{ color: '#ffffff', fontWeight: 'bold', fontSize: '1.8rem' }}>{stats.total}</h2>
                  <small className="text-light">Total Sensors</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={3} md={4} sm={6}>
              <Card className="text-center h-100 border-0" style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <FaCheckCircle className="text-success mb-2" size={24} />
                  <h2 style={{ color: '#51cf66', fontWeight: 'bold', fontSize: '1.8rem' }}>{stats.active}</h2>
                  <small className="text-light">Active</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={3} md={4} sm={6}>
              <Card className="text-center h-100 border-0" style={{ background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <FaExclamationTriangle className="text-danger mb-2" size={24} />
                  <h2 style={{ color: '#ff6b6b', fontWeight: 'bold', fontSize: '1.8rem' }}>{stats.offline}</h2>
                  <small className="text-light">Offline</small>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </div>

        {/* Filters */}
        <Card className="mb-4 border-0" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
          <Card.Header style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
            <div className="d-flex align-items-center">
              <FaFilter className="me-2 text-success" />
              <h5 className="mb-0 text-white">Filter Sensors</h5>
            </div>
          </Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col lg={8}>
                <div className="position-relative">
                  <FaSearch className="position-absolute" style={{ left: 12, top: 12, color: '#adb5bd' }} />
                  <Form.Control
                    type="text"
                    placeholder="Search sensors by ID or location..."
                    value={searchTerm}
                    onChange={handleSearchChange}
                    style={{ paddingLeft: 35, backgroundColor: '#16213e', borderColor: '#2a2a4e', color: 'white', borderRadius: '8px' }}
                  />
                </div>
              </Col>
              <Col lg={3}>
                <Form.Select value={statusFilter} onChange={handleStatusFilterChange} style={{ backgroundColor: '#16213e', borderColor: '#2a2a4e', color: 'white', borderRadius: '8px' }}>
                  <option value="ALL">All Statuses</option>
                  <option value="Active">Active</option>
                  <option value="Offline">Offline</option>
                </Form.Select>
              </Col>
              <Col lg={1}>
                <Button
                  variant="outline-secondary"
                  className="w-100"
                  onClick={() => {
                    setSearchTerm('');
                    setStatusFilter('ALL');
                  }}
                  style={{ borderColor: '#2a2a4e', color: 'white', borderRadius: '8px' }}
                >
                  <FaTimes className="me-1" /> Clear
                </Button>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Sensors Grid */}
        <div className="mb-4">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h6 className="text-white mb-0">
              <FaMicrochip className="me-2 text-success" />
              Sensor Fleet ({filteredSensors.length} sensors)
            </h6>
            <Badge bg="success" className="px-3 py-2">{stats.active} Online</Badge>
          </div>
          <Row className="g-3">
            {filteredSensors.map((sensor) => (
              <Col lg={4} md={6} key={sensor.sensor_id}>
                <Card
                  className="h-100 border-0 position-relative"
                  style={{
                    backgroundColor: '#1a1a2e',
                    border: '1px solid #2a2a4e',
                    borderRadius: '12px',
                    cursor: 'pointer',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                  }}
                  onClick={() => setSelectedSensor(sensor)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = 'translateY(-4px)';
                    e.currentTarget.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {/* ⭐ Always-visible delete button on the card */}
                  <Button
                    variant="danger"
                    size="sm"
                    title="Delete sensor"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDeleteModal(sensor);
                    }}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      zIndex: 10,
                      borderRadius: 6,
                      padding: '3px 10px',
                    }}
                  >
                    <FaTrash size={12} />
                  </Button>

                  <Card.Header className="d-flex justify-content-between align-items-center" style={{ backgroundColor: '#0f0f1a', borderBottom: '1px solid #2a2a4e' }}>
                    <div className="d-flex align-items-center">
                      <span className="me-2" style={{ fontSize: '1.2rem' }}>{getSensorTypeIcon(sensor.sensor_type)}</span>
                      <strong className="text-white">{sensor.sensor_id}</strong>
                    </div>
                    {getStatusBadge(sensor.status)}
                  </Card.Header>
                  <Card.Body className="d-flex flex-column">
                    <div className="mb-3">
                      <div className="d-flex align-items-center text-light mb-2">
                        <FaMapMarkerAlt className="me-2 text-danger flex-shrink-0" />
                        <span className="text-truncate">{sensor.location || 'Location not set'}</span>
                      </div>
                      <div className="text-secondary small ps-4">
                        📍 {safeFixed(sensor.latitude)}, {safeFixed(sensor.longitude)}
                      </div>
                      {(sensor as any).admin_name && (
                        <div className="text-secondary small ps-4 mt-1">
                          👤 {(sensor as any).admin_name}
                          {(sensor as any).admin_phone ? ` • ${(sensor as any).admin_phone}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="mt-auto pt-3 border-top" style={{ borderColor: '#2a2a4e' }}>
                      <div className="d-flex justify-content-between small text-secondary">
                        <span className="d-flex align-items-center">
                          <FaClock className="me-1" />
                          {sensor.last_heartbeat
                            ? new Date(sensor.last_heartbeat).toLocaleTimeString()
                            : '—'}
                        </span>
                        <span>
                          Installed:{' '}
                          {sensor.installed_at
                            ? new Date(sensor.installed_at).toLocaleDateString()
                            : '—'}
                        </span>
                      </div>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            ))}
            {filteredSensors.length === 0 && (
              <Col xs={12}>
                <Card className="text-center py-5 border-0" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                  <Card.Body>
                    <FaMicrochip size={48} className="text-secondary mb-3" />
                    <h5 className="text-white">No sensors found</h5>
                    <p className="text-secondary">
                      Click "Add Sensor" to create one, or adjust your filters.
                    </p>
                  </Card.Body>
                </Card>
              </Col>
            )}
          </Row>
        </div>

        {/* ═══════════════ Sensor Details Modal ═══════════════ */}
        <Modal
          show={selectedSensor !== null}
          onHide={handleCloseModal}
          size="xl"
          centered
          scrollable
        >
          <Modal.Header closeButton style={{ backgroundColor: '#1a1a2e', color: 'white', borderBottom: '1px solid #2a2a4e' }}>
            <Modal.Title style={{ color: 'white' }}>
              <FaMicrochip className="me-2 text-success" />
              Sensor Details - {selectedSensor?.sensor_id}
            </Modal.Title>
          </Modal.Header>
          {selectedSensor && (
            <Modal.Body style={{ backgroundColor: '#1a1a2e', color: '#f8f9fa' }}>
              <Row>
                <Col md={6}>
                  <div className="mb-3">
                    <h6 className="text-success mb-3">
                      <FaMicrochip className="me-2" /> Sensor Information
                    </h6>
                    <ListGroup className="mb-3">
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Type:</strong> {selectedSensor.sensor_type}
                      </ListGroup.Item>
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Status:</strong> {getStatusBadge(selectedSensor.status)}
                      </ListGroup.Item>
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Location:</strong> {selectedSensor.location || 'Not set'}
                      </ListGroup.Item>
                      <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                        <strong>Coordinates:</strong>
                        <br />
                        <small>Lat: {safeFixed(selectedSensor.latitude)}</small>
                        <br />
                        <small>Lng: {safeFixed(selectedSensor.longitude)}</small>
                      </ListGroup.Item>
                    </ListGroup>
                  </div>
                </Col>

                <Col md={6}>
                  <div className="mb-3">
                    <h6 className="text-success mb-3">
                      <FaChartLine className="me-2" /> Latest Reading
                    </h6>
                    {readings[selectedSensor.sensor_id]?.length > 0 ? (
                      <ListGroup>
                        {readings[selectedSensor.sensor_id][0].smoke_ppm !== null &&
                         readings[selectedSensor.sensor_id][0].smoke_ppm !== undefined && (
                          <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                            <strong>💨 Smoke:</strong> {readings[selectedSensor.sensor_id][0].smoke_ppm} PPM
                          </ListGroup.Item>
                        )}
                        {readings[selectedSensor.sensor_id][0].temperature !== null &&
                         readings[selectedSensor.sensor_id][0].temperature !== undefined && (
                          <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                            <strong>🌡️ Temperature:</strong> {readings[selectedSensor.sensor_id][0].temperature}°C
                          </ListGroup.Item>
                        )}
                        {readings[selectedSensor.sensor_id][0].flame_detected && (
                          <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                            <strong>🔥 Flame Detected:</strong>
                            <Badge bg="danger" className="ms-2">YES</Badge>
                          </ListGroup.Item>
                        )}
                        <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                          <strong>🕐 Last Reading:</strong>
                          <br />
                          {new Date(readings[selectedSensor.sensor_id][0].read_at).toLocaleString()}
                        </ListGroup.Item>
                      </ListGroup>
                    ) : (
                      <div className="text-center py-4" style={{ backgroundColor: '#16213e', borderRadius: '8px' }}>
                        <FaChartLine size={32} className="text-secondary mb-2" />
                        <p className="text-secondary mb-0">No readings available</p>
                        <small className="text-secondary">
                          Live readings appear when the ESP32 sends telemetry.
                        </small>
                      </div>
                    )}
                  </div>
                </Col>
              </Row>

              <div className="mt-3">
                <h6 className="text-warning mb-3">👤 Owner Information</h6>
                <ListGroup>
                  <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                    <div className="d-flex justify-content-between">
                      <span><strong>Name:</strong></span>
                      <span>
                        {(selectedSensor as any).admin_name ||
                         (selectedSensor as any).name ||
                         'Not set'}
                      </span>
                    </div>
                  </ListGroup.Item>
                  <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                    <div className="d-flex justify-content-between">
                      <span><strong>Phone:</strong></span>
                      {((selectedSensor as any).admin_phone || (selectedSensor as any).phone) ? (
                        <a
                          href={`tel:${(selectedSensor as any).admin_phone || (selectedSensor as any).phone}`}
                          className="text-warning text-decoration-none"
                        >
                          {(selectedSensor as any).admin_phone || (selectedSensor as any).phone}
                        </a>
                      ) : (
                        <span>Not set</span>
                      )}
                    </div>
                  </ListGroup.Item>
                  <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                    <div className="d-flex justify-content-between">
                      <span><strong>Address:</strong></span>
                      <span>{(selectedSensor as any).admin_address || selectedSensor.location || 'Not set'}</span>
                    </div>
                  </ListGroup.Item>
                </ListGroup>
              </div>

              {readings[selectedSensor.sensor_id]?.length > 0 && (
                <div className="mt-3">
                  <h6 className="text-success mb-3">
                    <FaChartLine className="me-2" /> Sensor Readings (Last 20)
                  </h6>
                  <div style={{ height: '280px' }}>
                    <Line
                      data={getChartData(selectedSensor.sensor_id)}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index' as const, intersect: false },
                        plugins: {
                          legend: { labels: { color: '#f8f9fa' } },
                          tooltip: {
                            backgroundColor: '#1a1a2e',
                            titleColor: '#f8f9fa',
                            bodyColor: '#adb5bd',
                          },
                        },
                        scales: {
                          x: { ticks: { color: '#adb5bd' }, grid: { color: '#2a2a4e' } },
                          y: {
                            type: 'linear' as const,
                            display: true,
                            position: 'left' as const,
                            title: { display: true, text: 'Smoke (PPM)', color: '#f8f9fa' },
                            ticks: { color: '#adb5bd' },
                            grid: { color: '#2a2a4e' },
                          },
                          y1: {
                            type: 'linear' as const,
                            display: true,
                            position: 'right' as const,
                            title: { display: true, text: 'Temperature (°C)', color: '#f8f9fa' },
                            ticks: { color: '#adb5bd' },
                            grid: { drawOnChartArea: false },
                          },
                        },
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="mt-3">
                <h6 className="text-success mb-3">
                  <FaMapMarkerAlt className="me-2" /> Sensor Location
                </h6>
                <div style={{ height: '220px', backgroundColor: '#16213e', borderRadius: '8px', overflow: 'hidden' }}>
                  <iframe
                    title="Sensor Location"
                    width="100%"
                    height="220"
                    frameBorder="0"
                    style={{ border: 0 }}
                    src={`https://www.openstreetmap.org/export/embed.html?bbox=${
                      safeCoord(selectedSensor.longitude) - 0.01
                    }%2C${
                      safeCoord(selectedSensor.latitude) - 0.01
                    }%2C${
                      safeCoord(selectedSensor.longitude) + 0.01
                    }%2C${
                      safeCoord(selectedSensor.latitude) + 0.01
                    }&layer=mapnik&marker=${
                      safeCoord(selectedSensor.latitude)
                    }%2C${
                      safeCoord(selectedSensor.longitude)
                    }`}
                    allowFullScreen
                  />
                </div>
              </div>
            </Modal.Body>
          )}
          <Modal.Footer
            style={{
              backgroundColor: '#1a1a2e',
              borderTop: '1px solid #2a2a4e',
              justifyContent: 'space-between',
            }}
          >
            <div>
              {selectedSensor && (
                <Button
                  variant="danger"
                  onClick={() => openDeleteModal(selectedSensor)}
                >
                  <FaTrash className="me-2" /> Delete Sensor
                </Button>
              )}
            </div>
            <div className="d-flex gap-2">
              {selectedSensor && (
                <Button variant="warning" onClick={() => openEditModal(selectedSensor)}>
                  ✏️ Edit
                </Button>
              )}
              <Button variant="secondary" onClick={handleCloseModal}>Close</Button>
            </div>
          </Modal.Footer>
        </Modal>

        {/* ═══════════════ Delete Confirmation Modal ═══════════════ */}
        <Modal show={showDeleteModal} onHide={closeDeleteModal} centered backdrop="static">
          <Modal.Header closeButton style={{ backgroundColor: '#2a0f0f', color: 'white', borderBottom: '1px solid #5a2020' }}>
            <Modal.Title style={{ color: '#ff6b6b' }}>
              <FaTrash className="me-2" /> Delete Sensor
            </Modal.Title>
          </Modal.Header>
          <Modal.Body style={{ backgroundColor: '#1a1a2e', color: '#f8f9fa' }}>
            {deleteError && (
              <Alert variant="danger" style={{ borderRadius: 8 }}>
                <FaExclamationTriangle className="me-2" /> {deleteError}
              </Alert>
            )}
            <Alert variant="warning" style={{ borderRadius: 8 }}>
              <strong>⚠️ This action cannot be undone.</strong>
              <div className="mt-2" style={{ fontSize: '0.9rem' }}>
                Deleting <code>{sensorToDelete?.sensor_id}</code> will remove the sensor
                document from Firestore. The ESP32 will keep running and will
                re-create the document on its next telemetry packet (with only
                live readings — the owner info you entered will be lost).
              </div>
            </Alert>

            {sensorToDelete && (
              <ListGroup className="mb-3">
                <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                  <strong>Sensor ID:</strong> {sensorToDelete.sensor_id}
                </ListGroup.Item>
                <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                  <strong>Owner:</strong>{' '}
                  {(sensorToDelete as any).admin_name ||
                   (sensorToDelete as any).name ||
                   'Not set'}
                </ListGroup.Item>
                <ListGroup.Item style={{ backgroundColor: '#16213e', color: '#f8f9fa', borderColor: '#2a2a4e' }}>
                  <strong>Location:</strong> {sensorToDelete.location || 'Not set'}
                </ListGroup.Item>
              </ListGroup>
            )}

            <Form.Group>
              <Form.Label style={{ color: '#adb5bd', fontSize: '0.85rem' }}>
                Type <code>{sensorToDelete?.sensor_id}</code> below to confirm:
              </Form.Label>
              <Form.Control
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={sensorToDelete?.sensor_id}
                autoFocus
                style={{
                  backgroundColor: '#16213e',
                  borderColor: '#5a2020',
                  color: 'white',
                  borderRadius: 8,
                }}
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer style={{ backgroundColor: '#1a1a2e', borderTop: '1px solid #2a2a4e' }}>
            <Button variant="secondary" onClick={closeDeleteModal} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDeleteSensor}
              disabled={
                deleting ||
                deleteConfirmText.trim() !== sensorToDelete?.sensor_id
              }
            >
              {deleting ? (
                <><Spinner animation="border" size="sm" className="me-2" /> Deleting...</>
              ) : (
                <><FaTrash className="me-2" /> Delete Permanently</>
              )}
            </Button>
          </Modal.Footer>
        </Modal>

        {/* ═══════════════ Add / Edit Sensor Modal ═══════════════ */}
        <Modal show={showAddModal} onHide={closeAddModal} size="lg" centered backdrop="static" scrollable>
          <Modal.Header closeButton style={{ backgroundColor: '#1a1a2e', color: 'white', borderBottom: '1px solid #2a2a4e' }}>
            <Modal.Title style={{ color: 'white' }}>
              {isEditing ? (
                <><FaSave className="me-2 text-warning" /> Edit Sensor</>
              ) : (
                <><FaPlus className="me-2 text-success" /> Add New Sensor</>
              )}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body style={{ backgroundColor: '#1a1a2e', color: '#f8f9fa' }}>
            {saveSuccess && (
              <Alert variant="success" className="d-flex align-items-center" style={{ borderRadius: 8 }}>
                <FaCheckCircle className="me-2" /> {saveSuccess}
              </Alert>
            )}
            {formErrors._global && (
              <Alert variant="danger" style={{ borderRadius: 8 }}>
                <FaExclamationTriangle className="me-2" /> {formErrors._global}
              </Alert>
            )}

            <Alert variant="info" style={{ borderRadius: 8, fontSize: '0.85rem' }}>
              <strong>ℹ️ Sensor ID must match the ESP32.</strong> Enter the
              same ID that's flashed on the device (e.g. <code>SENSOR_02</code>).
              It must be unique.
            </Alert>

            <Form>
              <Row className="g-3">
                <Col md={12}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Sensor ID *</Form.Label>
                    <Form.Control
                      name="sensor_id"
                      value={newSensor.sensor_id}
                      onChange={handleFormChange}
                      isInvalid={!!formErrors.sensor_id}
                      placeholder="e.g. SENSOR_02"
                      disabled={isEditing}
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.sensor_id}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={6}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Owner Name *</Form.Label>
                    <Form.Control
                      name="name"
                      value={newSensor.name}
                      onChange={handleFormChange}
                      isInvalid={!!formErrors.name}
                      placeholder="e.g. Juan Del Castillo"
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.name}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={6}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Owner Phone *</Form.Label>
                    <Form.Control
                      name="phone"
                      value={newSensor.phone}
                      onChange={handleFormChange}
                      isInvalid={!!formErrors.phone}
                      placeholder="e.g. +639171234567"
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.phone}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={12}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Owner Address</Form.Label>
                    <Form.Control
                      name="address"
                      value={newSensor.address}
                      onChange={handleFormChange}
                      placeholder="e.g. Del Castillo Boarding House, Room 02, 1st Floor"
                      style={inputStyle}
                    />
                  </Form.Group>
                </Col>

                <Col md={6}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Floor *</Form.Label>
                    <Form.Control
                      name="floor"
                      value={newSensor.floor}
                      onChange={handleFormChange}
                      isInvalid={!!formErrors.floor}
                      placeholder="1st Floor"
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.floor}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={6}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Room *</Form.Label>
                    <Form.Control
                      name="room"
                      value={newSensor.room}
                      onChange={handleFormChange}
                      isInvalid={!!formErrors.room}
                      placeholder="Room 02"
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.room}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={5}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Latitude *</Form.Label>
                    <Form.Control
                      name="latitude"
                      value={newSensor.latitude}
                      onChange={handleFormChange}
                      placeholder="e.g. 18.253749"
                      isInvalid={!!formErrors.latitude}
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.latitude}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={5}>
                  <Form.Group>
                    <Form.Label style={labelStyle}>Longitude *</Form.Label>
                    <Form.Control
                      name="longitude"
                      value={newSensor.longitude}
                      onChange={handleFormChange}
                      placeholder="e.g. 121.996358"
                      isInvalid={!!formErrors.longitude}
                      style={inputStyle}
                    />
                    <Form.Control.Feedback type="invalid">{formErrors.longitude}</Form.Control.Feedback>
                  </Form.Group>
                </Col>

                <Col md={2} className="d-flex align-items-end">
                  <Button
                    variant="outline-success"
                    className="w-100"
                    onClick={useMyLocation}
                    disabled={locating}
                    style={{ borderRadius: 8, height: 38 }}
                    title="Use my current location"
                  >
                    {locating ? <Spinner animation="border" size="sm" /> : <FaCrosshairs />}
                  </Button>
                </Col>

                <Col md={12}>
                  <MapPicker
                    latitude={parseFloat(newSensor.latitude)}
                    longitude={parseFloat(newSensor.longitude)}
                    onChange={handleMapChange}
                    height={280}
                  />
                </Col>
              </Row>
            </Form>
          </Modal.Body>
          <Modal.Footer style={{ backgroundColor: '#1a1a2e', borderTop: '1px solid #2a2a4e' }}>
            <Button variant="secondary" onClick={closeAddModal} disabled={saving}>
              Cancel
            </Button>
            <Button variant="success" onClick={handleSaveSensor} disabled={saving}>
              {saving ? (
                <><Spinner animation="border" size="sm" className="me-2" /> Saving...</>
              ) : (
                <><FaSave className="me-2" /> {isEditing ? 'Update Sensor' : 'Save Sensor'}</>
              )}
            </Button>
          </Modal.Footer>
        </Modal>
      </Container>
    </div>
  );
};

export default Sensors;