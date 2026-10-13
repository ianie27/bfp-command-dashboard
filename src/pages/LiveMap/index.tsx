// src/pages/LiveMap/index.tsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Card, Button, Badge, Alert, ListGroup } from 'react-bootstrap';
import {
  FaExclamationTriangle,
  FaTruck,
  FaSync,
  FaExpand,
  FaCompress,
  FaMapMarkedAlt,
} from 'react-icons/fa';
import DispatcherGeoMap from '../../components/Map/DispatcherGeoMap';
import { subscribeToIncidents } from '../../services/incidentService';
import { subscribeToUnits } from '../../services/unitService';
import type { Incident, ResponseUnit } from '../../types';

const LiveMap: React.FC = () => {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [units, setUnits] = useState<ResponseUnit[]>([]);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [highPriorityAlert, setHighPriorityAlert] = useState<Incident | null>(null);

  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubIncidents = subscribeToIncidents((data) => {
      const activeIncidents = data.filter(inc =>
        !['Resolved', 'Cancelled'].includes(inc.status)
      );
      setIncidents(activeIncidents);

      const newHighPriority = activeIncidents.find(inc =>
        inc.threat_level === 'RED' &&
        new Date(inc.reported_at).getTime() > Date.now() - 60000
      );
      if (newHighPriority) {
        setHighPriorityAlert(newHighPriority);
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = window.setTimeout(() => {
          setHighPriorityAlert(null);
        }, 10000);
      }
    });

    const unsubUnits = subscribeToUnits((data) => {
      setUnits(data.filter(unit => unit.status !== 'OffDuty'));
    });

    return () => {
      unsubIncidents();
      unsubUnits();
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const toggleFullscreen = useCallback((): void => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  const handleDismissAlert = useCallback((): void => {
    setHighPriorityAlert(null);
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const activeIncidents = incidents.filter(inc =>
    !['Resolved', 'Cancelled'].includes(inc.status)
  );

  const availableUnits = units.filter(u => u.status === 'Available');

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#0f0f1a'
    }}>
      {highPriorityAlert && (
        <Alert
          variant="danger"
          style={{
            position: 'absolute',
            top: '80px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            minWidth: '400px',
            backgroundColor: 'rgba(220, 53, 69, 0.95)',
            color: 'white',
          }}
          onClose={handleDismissAlert}
          dismissible
        >
          <FaExclamationTriangle size={24} className="me-3" />
          <div>
            <strong>HIGH PRIORITY INCIDENT!</strong>
            <br />
            <span>Incident {highPriorityAlert.incident_id}</span>
          </div>
        </Alert>
      )}

      <div style={{
        background: 'linear-gradient(135deg, #0b132b, #1a1a2e)',
        borderBottom: '1px solid rgba(244, 162, 97, 0.15)',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 10,
      }}>
        <div className="d-flex align-items-center">
          <FaMapMarkedAlt className="me-3" size={24} style={{ color: '#f4a261' }} />
          <h2 className="mb-0 text-white" style={{ fontSize: '1.5rem', fontWeight: 600 }}>
            Live GeoMap
          </h2>
          <Badge bg="success" className="ms-3">
            <FaSync className="me-1" /> Live
          </Badge>
        </div>

        <div className="d-flex align-items-center gap-3">
          <Badge bg="danger" className="px-3 py-2">
            <FaExclamationTriangle className="me-1" />
            {activeIncidents.length} Active
          </Badge>
          <Badge bg="success" className="px-3 py-2">
            <FaTruck className="me-1" />
            {availableUnits.length} Available
          </Badge>
          <Button
            variant="outline-light"
            size="sm"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <FaCompress /> : <FaExpand />}
            {isFullscreen ? ' Exit' : ' Fullscreen'}
          </Button>
        </div>
      </div>

      <div style={{ flex: 1, position: 'relative' }}>
        <DispatcherGeoMap />
      </div>

      <div style={{
        position: 'absolute',
        top: '100px',
        left: '20px',
        zIndex: 500,
        width: '300px',
      }}>
        <Card style={{
          background: 'rgba(11, 19, 43, 0.9)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(244, 162, 97, 0.15)',
          borderRadius: '16px',
          color: 'white',
        }}>
          <Card.Header style={{ background: 'transparent', borderBottom: '1px solid rgba(244, 162, 97, 0.15)', fontWeight: 600 }}>
            <FaExclamationTriangle className="me-2 text-danger" />
            Active Incidents ({activeIncidents.length})
          </Card.Header>
          <ListGroup variant="flush" style={{ maxHeight: '250px', overflowY: 'auto' }}>
            {activeIncidents.slice(0, 5).map(incident => (
              <ListGroup.Item
                key={incident.incident_id}
                style={{ background: 'transparent', color: 'rgba(255,255,255,0.8)', borderBottom: '1px solid rgba(244,162,97,0.1)' }}
              >
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <Badge bg={incident.threat_level === 'RED' ? 'danger' : 'warning'} className="me-2">
                      {incident.threat_level}
                    </Badge>
                    <strong className="small">{incident.incident_id}</strong>
                  </div>
                  <Badge bg="secondary" className="small">{incident.status}</Badge>
                </div>
                <small className="d-block text-truncate" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {incident.location_address || `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                </small>
              </ListGroup.Item>
            ))}
            {activeIncidents.length === 0 && (
              <ListGroup.Item style={{ background: 'transparent', color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: '2rem' }}>
                No active incidents
              </ListGroup.Item>
            )}
          </ListGroup>
        </Card>
      </div>

      <div style={{
        position: 'absolute',
        top: '100px',
        right: '20px',
        zIndex: 500,
        width: '280px',
      }}>
        <Card style={{
          background: 'rgba(11, 19, 43, 0.9)',
          backdropFilter: 'blur(10px)',
          border: '1px solid rgba(244, 162, 97, 0.15)',
          borderRadius: '16px',
          color: 'white',
        }}>
          <Card.Header style={{ background: 'transparent', borderBottom: '1px solid rgba(244, 162, 97, 0.15)', fontWeight: 600 }}>
            <FaTruck className="me-2 text-success" />
            Response Units
          </Card.Header>
          <ListGroup variant="flush" style={{ maxHeight: '250px', overflowY: 'auto' }}>
            {units.filter(u => u.status !== 'OffDuty').slice(0, 5).map(unit => (
              <ListGroup.Item
                key={unit.unit_id}
                style={{ background: 'transparent', color: 'rgba(255,255,255,0.8)', borderBottom: '1px solid rgba(244,162,97,0.1)' }}
              >
                <div className="d-flex justify-content-between align-items-start">
                  <div>
                    <strong className="small">{unit.unit_name}</strong>
                    <br />
                    <small style={{ color: 'rgba(255,255,255,0.4)' }}>{unit.unit_code}</small>
                  </div>
                  <Badge bg={unit.status === 'Available' ? 'success' : unit.status === 'Dispatched' ? 'primary' : unit.status === 'EnRoute' ? 'info' : 'warning'}>
                    {unit.status}
                  </Badge>
                </div>
              </ListGroup.Item>
            ))}
          </ListGroup>
        </Card>
      </div>
    </div>
  );
};

export default LiveMap;