// ============================================================
// SensorDetailsModal.jsx
// EMBERNET ADMIN PORTAL — Sensor Details with Owner Information
// Real-time via Firestore onSnapshot + inline Owner Info editing
// ============================================================

import React, { useEffect, useState, useMemo } from 'react';

// ⭐ Firebase — pulls everything from your actual bootstrap
import {
  firestore,
  doc,
  onSnapshot,
  updateDoc,
} from '../../services/firebase/firebase';

import ThreatBadge from './ThreatBadge';
import './sensorStyles.css';

const EMPTY_OWNER_FORM = {
  admin_name: '',
  admin_phone: '',
  admin_email: '',
  admin_address: '',
  admin_role: '',
  admin_emergency: '',
};

export default function SensorDetailsModal({ sensorId, onClose }) {
  const [sensor, setSensor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [isEditing, setIsEditing] = useState(false);
  const [ownerForm, setOwnerForm] = useState(EMPTY_OWNER_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(null);

  // ----------------------------------------------------------
  // Real-time listener
  // ----------------------------------------------------------
  useEffect(() => {
    if (!sensorId) {
      setError('No sensor selected.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const ref = doc(firestore, 'iot_sensors', sensorId);

    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          setSensor({ id: snap.id, ...snap.data() });
          setError(null);
        } else {
          setSensor(null);
          setError(`Sensor "${sensorId}" not found in Firestore.`);
        }
        setLoading(false);
      },
      (err) => {
        console.error('[SensorDetailsModal] Firestore error:', err);
        setError(err?.message || 'Failed to load sensor data.');
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [sensorId]);

  // ----------------------------------------------------------
  // Escape key + body-scroll lock
  // ----------------------------------------------------------
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (isEditing) {
          setIsEditing(false);
          setSaveError(null);
        } else {
          onClose?.();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose, isEditing]);

  // ----------------------------------------------------------
  // Sync owner form when sensor changes (unless editing)
  // ----------------------------------------------------------
  useEffect(() => {
    if (!sensor || isEditing) return;
    setOwnerForm({
      admin_name:      sensor.admin_name      || sensor.name  || '',
      admin_phone:     sensor.admin_phone     || sensor.phone || '',
      admin_email:     sensor.admin_email     || '',
      admin_address:   sensor.admin_address   || sensor.location || '',
      admin_role:      sensor.admin_role      || '',
      admin_emergency: sensor.admin_emergency || '',
    });
  }, [sensor, isEditing]);

  // ----------------------------------------------------------
  // Map URL (memoized)
  // ----------------------------------------------------------
  const mapSrc = useMemo(() => {
    const lat = Number(sensor?.latitude);
    const lng = Number(sensor?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const d = 0.01;
    const bbox = `${lng - d}%2C${lat - d}%2C${lng + d}%2C${lat + d}`;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lng}`;
  }, [sensor?.latitude, sensor?.longitude]);

  // ----------------------------------------------------------
  // Edit handlers
  // ----------------------------------------------------------
  const beginEdit = () => {
    setSaveError(null);
    setSaveSuccess(null);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setSaveError(null);
    if (sensor) {
      setOwnerForm({
        admin_name:      sensor.admin_name      || sensor.name  || '',
        admin_phone:     sensor.admin_phone     || sensor.phone || '',
        admin_email:     sensor.admin_email     || '',
        admin_address:   sensor.admin_address   || sensor.location || '',
        admin_role:      sensor.admin_role      || '',
        admin_emergency: sensor.admin_emergency || '',
      });
    }
  };

  const handleOwnerFieldChange = (e) => {
    const { name, value } = e.target;
    setOwnerForm((prev) => ({ ...prev, [name]: value }));
  };

  const saveOwnerInfo = async () => {
    if (!sensor) return;
    if (!ownerForm.admin_name.trim()) {
      setSaveError('Owner name is required.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const ref = doc(firestore, 'iot_sensors', sensor.sensor_id || sensor.id);
      await updateDoc(ref, {
        admin_name:      ownerForm.admin_name.trim(),
        admin_phone:     ownerForm.admin_phone.trim(),
        admin_email:     ownerForm.admin_email.trim(),
        admin_address:   ownerForm.admin_address.trim(),
        admin_role:      ownerForm.admin_role.trim(),
        admin_emergency: ownerForm.admin_emergency.trim(),
        updated_at:      new Date().toISOString(),
      });
      setSaveSuccess('Owner information saved.');
      setIsEditing(false);
      setTimeout(() => setSaveSuccess(null), 2500);
    } catch (err) {
      console.error('[SensorDetailsModal] Save failed:', err);
      setSaveError(
        err?.message ||
          'Failed to save. Check that Firestore rules allow this update.'
      );
    } finally {
      setSaving(false);
    }
  };

  // ----------------------------------------------------------
  // Loading
  // ----------------------------------------------------------
  if (loading) {
    return (
      <ModalShell onClose={onClose}>
        <div style={{ padding: '40px 24px', color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="ember-spinner" />
          Loading sensor details…
        </div>
      </ModalShell>
    );
  }

  // ----------------------------------------------------------
  // Error
  // ----------------------------------------------------------
  if (error || !sensor) {
    return (
      <ModalShell onClose={onClose}>
        <div style={{ padding: '40px 24px' }}>
          <p style={{ color: '#f87171', fontWeight: 600 }}>
            {error || 'Sensor not found.'}
          </p>
          <p style={{ marginTop: 8, color: '#94a3b8', fontSize: '0.875rem' }}>
            Check the sensor ID and confirm your Firestore rules allow reads on{' '}
            <code style={{ background: '#1e293b', padding: '2px 6px', borderRadius: 4, color: '#fdba74' }}>
              iot_sensors/{sensorId}
            </code>
            .
          </p>
          <button onClick={onClose} className="ember-btn ember-btn-secondary" style={{ marginTop: 24 }}>
            Close
          </button>
        </div>
      </ModalShell>
    );
  }

  // ----------------------------------------------------------
  // Derived values
  // ----------------------------------------------------------
  const displayLocation =
    sensor.location_name || sensor.location || 'Unknown Location';

  const hasReading =
    typeof sensor.temperature === 'number' ||
    typeof sensor.humidity === 'number' ||
    typeof sensor.gas === 'number';

  const ownerName      = sensor.admin_name      || sensor.name  || 'Unknown';
  const ownerPhone     = sensor.admin_phone     || sensor.phone || null;
  const ownerEmail     = sensor.admin_email     || null;
  const ownerAddress   = sensor.admin_address   || sensor.location || 'N/A';
  const ownerRole      = sensor.admin_role      || null;
  const ownerEmergency = sensor.admin_emergency || null;

  // ----------------------------------------------------------
  // Render
  // ----------------------------------------------------------
  return (
    <ModalShell onClose={onClose}>
      {/* HEADER */}
      <div className="ember-modal-header">
        <h2 className="ember-modal-title">
          <svg
            style={{ width: 20, height: 20, color: '#fb923c' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
            />
          </svg>
          Sensor Details – {sensor.sensor_id || sensor.id}
        </h2>
        <button className="ember-modal-close" onClick={onClose} aria-label="Close">
          <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* BODY */}
      <div className="ember-modal-body">
        {saveSuccess && (
          <div className="ember-alert ember-alert-success">
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {saveSuccess}
          </div>
        )}
        {saveError && (
          <div className="ember-alert ember-alert-danger">
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M4.93 4.93l14.14 14.14M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {saveError}
          </div>
        )}

        {/* TOP ROW */}
        <div className="ember-grid-2">
          <div>
            <h3 className="ember-section-title emerald">
              <SectionIcon name="sensor" />
              Sensor Information
            </h3>
            <div className="ember-section-card">
              <Row label="Type" value={sensor.sensor_type || 'Unknown'} />
              <Row
                label="Status"
                value={
                  <span className="ember-badge ember-badge-status">
                    <span className="ember-dot" />
                    {sensor.status || 'Unknown'}
                  </span>
                }
              />
              <Row label="Location" value={displayLocation} />
              <Row
                label="Coordinates"
                value={
                  <span style={{ lineHeight: 1.5 }}>
                    Lat: {formatCoord(sensor.latitude)}
                    <br />
                    Lng: {formatCoord(sensor.longitude)}
                  </span>
                }
              />
            </div>
          </div>

          <div>
            <h3 className="ember-section-title sky">
              <SectionIcon name="chart" />
              Latest Reading
            </h3>
            <div className="ember-section-card">
              {hasReading ? (
                <>
                  <Row
                    label="Temperature"
                    value={typeof sensor.temperature === 'number' ? `${sensor.temperature.toFixed(2)} °C` : 'N/A'}
                  />
                  <Row
                    label="Humidity"
                    value={typeof sensor.humidity === 'number' ? `${sensor.humidity.toFixed(2)} %` : 'N/A'}
                  />
                  <Row
                    label="Gas / Smoke"
                    value={typeof sensor.gas === 'number' ? String(sensor.gas) : 'N/A'}
                  />
                  <Row
                    label="Flame"
                    value={sensor.flame === true ? 'DETECTED' : sensor.flame === false ? 'Normal' : 'N/A'}
                  />
                  <Row label="Threat Level" value={<ThreatBadge level={sensor.threat_level} />} />
                </>
              ) : (
                <div className="ember-empty">
                  <svg style={{ width: 40, height: 40, marginBottom: 8 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
                  </svg>
                  <span style={{ fontSize: '0.85rem' }}>No readings available</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* OWNER INFORMATION */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 className="ember-section-title orange" style={{ marginBottom: 12 }}>
              <SectionIcon name="user" />
              Owner Information
            </h3>
            {!isEditing && (
              <button
                onClick={beginEdit}
                className="ember-btn ember-btn-outline"
                style={{ padding: '4px 10px', fontSize: '0.75rem' }}
              >
                <SectionIcon name="edit" size={12} />
                Edit
              </button>
            )}
          </div>

          {!isEditing ? (
            <div className="ember-section-card">
              <Row label="Name" value={ownerName} />
              <Row
                label="Phone"
                value={
                  ownerPhone ? (
                    <a href={`tel:${ownerPhone}`} className="ember-link">{ownerPhone}</a>
                  ) : 'N/A'
                }
              />
              <Row
                label="Email"
                value={
                  ownerEmail ? (
                    <a href={`mailto:${ownerEmail}`} className="ember-link" style={{ wordBreak: 'break-all' }}>
                      {ownerEmail}
                    </a>
                  ) : 'N/A'
                }
              />
              <Row label="Address" value={ownerAddress} />
              <Row label="Role" value={ownerRole || 'N/A'} />
              {ownerEmergency && (
                <div className="ember-row" style={{ paddingTop: 12, borderTop: '1px solid #1e293b' }}>
                  <span style={{ color: '#f87171', fontWeight: 600 }}>Emergency:</span>
                  <a href={`tel:${ownerEmergency}`} className="ember-link-emergency">
                    {ownerEmergency}
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="ember-section-card">
              <FormField label="Name" name="admin_name" value={ownerForm.admin_name} onChange={handleOwnerFieldChange} placeholder="e.g. Juan Del Castillo" />
              <FormField label="Phone" name="admin_phone" value={ownerForm.admin_phone} onChange={handleOwnerFieldChange} placeholder="e.g. +639171234567" />
              <FormField label="Email" name="admin_email" type="email" value={ownerForm.admin_email} onChange={handleOwnerFieldChange} placeholder="e.g. owner@example.com" />
              <FormField label="Address" name="admin_address" value={ownerForm.admin_address} onChange={handleOwnerFieldChange} placeholder="e.g. Del Castillo Boarding House, Room 02" />
              <FormField label="Role" name="admin_role" value={ownerForm.admin_role} onChange={handleOwnerFieldChange} placeholder="e.g. Property Owner" />
              <FormField label="Emergency" name="admin_emergency" value={ownerForm.admin_emergency} onChange={handleOwnerFieldChange} placeholder="e.g. +639179876543" />

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                <button onClick={cancelEdit} className="ember-btn ember-btn-secondary" disabled={saving}>
                  Cancel
                </button>
                <button onClick={saveOwnerInfo} className="ember-btn ember-btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <span className="ember-spinner" style={{ width: 14, height: 14 }} />
                      Saving…
                    </>
                  ) : (
                    <>
                      <SectionIcon name="save" size={14} />
                      Save Changes
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* MAP */}
        <div>
          <h3 className="ember-section-title emerald">
            <SectionIcon name="map" />
            Sensor Location
          </h3>
          <div style={{ borderRadius: 8, border: '1px solid #1e293b', overflow: 'hidden', marginTop: 12 }}>
            {mapSrc ? (
              <iframe
                title={`Map for ${sensor.sensor_id || sensor.id}`}
                className="ember-map-frame"
                src={mapSrc}
              />
            ) : (
              <div className="ember-empty">
                <span style={{ fontSize: '0.85rem' }}>Coordinates not available</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <div className="ember-modal-footer">
        <button onClick={onClose} className="ember-btn ember-btn-secondary">
          Close
        </button>
      </div>
    </ModalShell>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function ModalShell({ children, onClose }) {
  return (
    <div className="ember-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="ember-modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="ember-row">
      <span className="ember-row-label">{label}:</span>
      <span className="ember-row-value">{value}</span>
    </div>
  );
}

function FormField({ label, name, value, onChange, type = 'text', placeholder }) {
  return (
    <div>
      <label
        htmlFor={`owner-${name}`}
        style={{ display: 'block', color: '#94a3b8', fontSize: '0.75rem', marginBottom: 4 }}
      >
        {label}
      </label>
      <input
        id={`owner-${name}`}
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="ember-input"
      />
    </div>
  );
}

function SectionIcon({ name, size = 16 }) {
  const props = {
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    viewBox: '0 0 24 24',
  };
  switch (name) {
    case 'sensor':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
        </svg>
      );
    case 'user':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      );
    case 'map':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      );
    case 'edit':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      );
    case 'save':
      return (
        <svg {...props}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
        </svg>
      );
    default:
      return null;
  }
}

function formatCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'N/A';
  return n.toFixed(6);
}