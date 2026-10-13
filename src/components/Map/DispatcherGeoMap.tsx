// ============================================================
// v29 DISPATCHER FIXES — STICKY SENSOR PINS + STICKY NOTIFICATIONS
//   • ⭐ YELLOW/RED sensor pins now STAY VISIBLE until the
//     incident is resolved/cancelled or the sensor is verified.
//     Transient heartbeat loss no longer hides the pin.
//   • ⭐ NEW: The centered YELLOW/RED alert OVERLAYS now use the
//     SAME sticky visibility rule as the pins. They persist for as
//     long as the pin is visible — heartbeat loss only silences
//     ALARM AUDIO, it never hides the overlay.
//   • ⭐ The pulsing/flash animation on a RED pin persists for
//     as long as the pin is visible (no more 6-second timeout).
//   • ⭐ The 100m RED circle halo has been REMOVED from the map.
//   • ⭐ Watchdog only silences ALARM AUDIO when a sensor goes
//     stale; it never downgrades threat_level or hides pins or
//     dismisses overlays.
//   • ⭐ YELLOW threat now triggers a distinct audible alarm.
//   • ⭐ FIX: YELLOW (gas/smoke) sensor now flows EXACTLY like
//     RED (flame): Acknowledge → Verify & Create Incident →
//     Dispatch → Resolve. Incident is created with the correct
//     threat_level ('YELLOW' or 'RED') based on sensor type.
//   • ⭐ FIX (v30): Sticky pins now survive the sensor document
//     itself going Inactive / threat_level going NORMAL.
//     We cache the original threat data (lat/lng, threat_level,
//     location, etc.) the moment the pin is created, and keep
//     rendering from that cache until the incident is resolved
//     or the sensor is verified.
//   • All v27 behaviour preserved:
//       – Yellow/Red alarms only fire for truly live sensors
//       – Blue verified pins disappear instantly on resolve
//       – Centered modal-style overlays for Fire/Gas alarms
//       – Dispatcher "Delete" is hide-only
//       – Station alarm banner
// ============================================================

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { GoogleMap, LoadScript, Marker, InfoWindow } from '@react-google-maps/api';
import type { Incident, ResponseUnit, IoTSensor } from '../../types';
import {
  subscribeToIncidents,
  updateIncidentStatus,
  hideIncidentFromDispatcher,
  hideAllIncidentsFromDispatcher,
  type IncidentStatus,
} from '../../services/incidentService';
import { subscribeToUnits, updateUnitStatus } from '../../services/unitService';
import {
  subscribeToSensors,
  resetSensorState,
} from '../../services/sensorService';
import { useAuth } from '../../hooks/useAuth';
import { Modal, Alert } from 'react-bootstrap';
import {
  FaFire, FaTruck, FaPhone, FaCheck, FaTimes, FaBullhorn,
  FaVolumeMute, FaMapMarkerAlt, FaClock, FaUser, FaExclamationTriangle,
  FaDirections, FaRoute, FaStop,
  FaChevronLeft, FaHistory, FaPhoneAlt, FaCrosshairs,
  FaBars, FaTimesCircle, FaExpand, FaCompress, FaTachometerAlt,
  FaPlus, FaMinus, FaHome, FaSignOutAlt,
  FaShieldAlt, FaSatelliteDish, FaBell, FaCalendarAlt,
  FaExclamationCircle, FaCheckCircle, FaSpinner, FaWifi,
  FaMicrophone, FaMicrophoneSlash, FaUsers,
  FaLocationArrow, FaFlag, FaRoad,
  FaClock as FaClockIcon, FaArrowsAlt, FaArrowDown,
  FaTrash, FaPhoneSlash, FaVolumeUp, FaSync, FaInfoCircle
} from 'react-icons/fa';
import toast from 'react-hot-toast';
import { io, Socket } from 'socket.io-client';
import FireAlarm from '../FireAlarm/FireAlarm';
import { firestore } from '../../services/firebase';
import {
  collection, onSnapshot, query, orderBy, doc, deleteDoc,
  updateDoc, Timestamp, serverTimestamp, addDoc, arrayUnion,
  where, getDocs, limit
} from 'firebase/firestore';

// ============================================================
// GOOGLE MAPS GLOBAL DECLARATION
// ============================================================
declare global {
  interface Window {
    google: typeof google;
  }
}

// ============================================================
// NULL-SAFETY HELPERS
// ============================================================
const isValidCoord = (lat: unknown, lng: unknown): lat is number => {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
};

const hasValidCoords = (obj: any): boolean =>
  !!obj && isValidCoord(obj.latitude, obj.longitude);

const parseCoord = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
};

// ============================================================
// SENSOR FRESHNESS / ACTIVE HELPERS
// ============================================================
const SENSOR_HEARTBEAT_TTL_MS = 60_000; // 60s freshness window

/**
 * Resolve the "last heartbeat" timestamp for a sensor doc.
 * Handles Date, Timestamp, number, ISO string.
 */
const getSensorLastSeenMs = (s: any): number => {
  if (!s) return 0;

  const candidates = [
    s.last_seen,
    s.last_heartbeat,
    s.heartbeat_at,
    s.updated_at,
    s.last_update,
    s.updatedAt,
  ];

  for (const c of candidates) {
    if (!c) continue;
    try {
      if (typeof c === 'number' && Number.isFinite(c)) return c;
      if (typeof c === 'string') {
        const t = Date.parse(c);
        if (Number.isFinite(t)) return t;
      }
      if (c?.toDate) {
        const t = c.toDate().getTime();
        if (Number.isFinite(t)) return t;
      }
      if (typeof c?.seconds === 'number') {
        return c.seconds * 1000;
      }
    } catch {
      /* ignore */
    }
  }
  return 0;
};

/**
 * A sensor is considered "live" only when:
 *   • its status is Active
 *   • it has a valid coordinate
 *   • it has a fresh heartbeat within SENSOR_HEARTBEAT_TTL_MS
 *   • is_online !== false
 *
 * NOTE: "live" only governs ALARM AUDIO and initial pin appearance.
 * Once a pin is on the map, visibility is governed by
 * isSensorVisibleOnDispatcherMap (sticky).
 */
const isSensorLive = (s: any): boolean => {
  if (!s) return false;
  if (s.status !== 'Active') return false;
  if (!hasValidCoords(s)) return false;

  if (s.is_online === false) return false;
  if (s.enabled === false) return false;
  if (s.power === false || s.power === 'off') return false;

  const lastMs = getSensorLastSeenMs(s);
  if (lastMs <= 0) {
    // No heartbeat info at all → treat as NOT live so we don't spam.
    return false;
  }

  return Date.now() - lastMs <= SENSOR_HEARTBEAT_TTL_MS;
};

// ============================================================
// INCIDENT STATUS NORMALIZATION
// ============================================================
const normalizeIncidentStatus = (rawStatus: unknown): string => {
  if (!rawStatus || typeof rawStatus !== 'string') return 'Received';

  const s = rawStatus.trim().toLowerCase();

  const statusMap: Record<string, string> = {
    'received': 'Received',
    'pending': 'Received',
    'new': 'Received',
    'verified': 'Verified',
    'confirmed': 'Verified',
    'dispatched': 'Dispatched',
    'enroute': 'EnRoute',
    'en_route': 'EnRoute',
    'en-route': 'EnRoute',
    'on_scene': 'OnScene',
    'onscene': 'OnScene',
    'on-scene': 'OnScene',
    'arrived': 'OnScene',
    'resolved': 'Resolved',
    'completed': 'Resolved',
    'done': 'Resolved',
    'closed': 'Resolved',
    'cancelled': 'Cancelled',
    'canceled': 'Cancelled',
    'false_alarm': 'Cancelled',
    'falsealarm': 'Cancelled',
  };

  return statusMap[s] || rawStatus;
};

const isTerminalIncidentStatus = (status: string): boolean => {
  const normalized = normalizeIncidentStatus(status);
  return normalized === 'Resolved' || normalized === 'Cancelled';
};

const formatResolvedTime = (resolvedAt: any): string => {
  if (!resolvedAt) return '';
  try {
    if (typeof resolvedAt === 'string') return new Date(resolvedAt).toLocaleString();
    if (resolvedAt?.toDate) return resolvedAt.toDate().toLocaleString();
    if (typeof resolvedAt === 'number') return new Date(resolvedAt).toLocaleString();
    if (resolvedAt?.seconds) return new Date(resolvedAt.seconds * 1000).toLocaleString();
  } catch (e) {
    console.warn('formatResolvedTime failed:', e);
  }
  return '';
};

const coerceTimestampToIso = (v: any): string => {
  try {
    if (!v) return new Date().toISOString();
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return new Date(v).toISOString();
    if (v?.toDate) return v.toDate().toISOString();
    if (v?.seconds) return new Date(v.seconds * 1000).toISOString();
  } catch (e) {
    console.warn('coerceTimestampToIso failed:', e);
  }
  return new Date().toISOString();
};

// ============================================================
// ⭐ helper: is this incident hidden from dispatcher?
// ============================================================
const isHiddenFromDispatcher = (inc: any): boolean =>
  inc?.hidden_from_dispatcher === true;

// ============================================================
// ⭐ SENSOR VISIBILITY — STICKY VERSION (v30 FIXED)
// ============================================================
const stickySensorPinIdsRef = new Set<string>();

// ⭐ Cache of the original threat data for sticky pins. This ensures
//    the pin remains visible with the correct color/location even
//    if the live sensor document is updated to Inactive / NORMAL.
interface StickySensorSnapshot {
  threat_level: 'RED' | 'YELLOW';
  latitude: number;
  longitude: number;
  location_name?: string;
  location?: string;
  sensor_type?: string;
  building?: string;
  room?: string;
  floor?: string;
  temperature?: number;
  humidity?: number;
}
const stickySensorDataRef = new Map<string, StickySensorSnapshot>();

/**
 * Clear sticky state for a sensor (called on verify / resolve).
 */
const clearStickySensor = (sensorId: string): void => {
  stickySensorPinIdsRef.delete(sensorId);
  stickySensorDataRef.delete(sensorId);
};

const isSensorVisibleOnDispatcherMap = (s: {
  threat_level?: string | null;
  verified?: boolean;
  incident_id?: string | null;
  status?: string;
  sensor_id?: string;
}): boolean => {
  if (!s) return false;

  // BLUE — verified / linked to an incident (always show if verified)
  if (s.verified === true) return true;
  if (s.incident_id) return true;

  // ⭐ STICKY: if this sensor already had a threat pin, keep showing it
  //    even if it's temporarily offline/stale OR the sensor document
  //    itself has changed to Inactive / threat_level NORMAL.
  if (s.sensor_id && stickySensorPinIdsRef.has(s.sensor_id)) {
    const cached = stickySensorDataRef.get(s.sensor_id);
    if (cached && (cached.threat_level === 'RED' || cached.threat_level === 'YELLOW')) {
      return true;
    }
    // Sticky flag without cached data is invalid — clean it up.
    if (!cached) {
      stickySensorPinIdsRef.delete(s.sensor_id);
    }
  }

  // For non-sticky sensors we require the sensor to be Active.
  if (s.status !== 'Active') return false;

  // For brand-new unverified sensors, they must be LIVE (online + fresh)
  if (!isSensorLive(s as any)) return false;

  // RED — flame detected
  if (s.threat_level === 'RED') {
    if (s.sensor_id) {
      stickySensorPinIdsRef.add(s.sensor_id);
      stickySensorDataRef.set(s.sensor_id, {
        threat_level: 'RED',
        latitude: (s as any).latitude,
        longitude: (s as any).longitude,
        location_name: (s as any).location_name,
        location: (s as any).location,
        sensor_type: (s as any).sensor_type,
        building: (s as any).building,
        room: (s as any).room,
        floor: (s as any).floor,
        temperature: (s as any).temperature,
        humidity: (s as any).humidity,
      });
    }
    return true;
  }

  // YELLOW — gas / smoke detected
  if (s.threat_level === 'YELLOW') {
    if (s.sensor_id) {
      stickySensorPinIdsRef.add(s.sensor_id);
      stickySensorDataRef.set(s.sensor_id, {
        threat_level: 'YELLOW',
        latitude: (s as any).latitude,
        longitude: (s as any).longitude,
        location_name: (s as any).location_name,
        location: (s as any).location,
        sensor_type: (s as any).sensor_type,
        building: (s as any).building,
        room: (s as any).room,
        floor: (s as any).floor,
        temperature: (s as any).temperature,
        humidity: (s as any).humidity,
      });
    }
    return true;
  }

  // NORMAL or anything else → hide
  return false;
};

/**
 * ⭐ Merge a raw sensor doc with its sticky snapshot (if any).
 *    This ensures the map keeps rendering the pin with the correct
 *    threat_level / coords / location even if the live sensor doc
 *    has been updated to Inactive or NORMAL.
 */
const mergeWithStickySnapshot = (s: SensorWithThreat): SensorWithThreat => {
  if (!s.sensor_id) return s;
  if (s.verified || s.incident_id) return s; // blue — no need to override

  const cached = stickySensorDataRef.get(s.sensor_id);
  if (!cached) return s;

  const liveHasCoords = hasValidCoords(s);

  return {
    ...s,
    threat_level: cached.threat_level,
    latitude: liveHasCoords ? s.latitude : cached.latitude,
    longitude: liveHasCoords ? s.longitude : cached.longitude,
    location_name: s.location_name || cached.location_name,
    location: s.location || cached.location || '',
    sensor_type: s.sensor_type || cached.sensor_type || s.sensor_type,
    building: s.building || cached.building,
    room: s.room || cached.room,
    floor: s.floor || cached.floor,
    temperature: s.temperature ?? cached.temperature,
    humidity: s.humidity ?? cached.humidity,
    // ⭐ Force status to 'Active' so downstream consumers don't filter it out
    status: 'Active',
  } as SensorWithThreat;
};

// ============================================================
// TYPES
// ============================================================
interface SensorWithThreat extends Omit<IoTSensor, 'battery_level' | 'status' | 'sensor_type' | 'last_heartbeat'> {
  temperature?: number;
  humidity?: number;
  battery_level?: number;
  last_seen?: string;
  last_heartbeat?: string;
  heartbeat_at?: string;
  updated_at?: any;
  status: string;
  latitude: number;
  longitude: number;
  location: string;
  sensor_id: string;
  sensor_type: string;

  location_name?: string;
  building?: string;
  room?: string;
  floor?: string;

  dispatcher_acknowledged?: boolean;
  dispatcher_acknowledged_at?: string;
  dispatcher_acknowledged_by?: string;
  verified?: boolean;
  verified_at?: string;
  verified_by_name?: string;
  incident_id?: string;

  is_online?: boolean;
  enabled?: boolean;
  power?: boolean | string;
}

interface MobileEmergencyCall {
  id: string;
  callId?: string;
  userId?: string;
  caller_name?: string;
  caller_phone?: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  address?: string;
  status: string;
  source: string;
  acknowledged: boolean;
  verified?: boolean;
  verified_at?: string;
  verified_by?: string;
  verified_by_name?: string;
  accuracy?: number;
  provider?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  acknowledged_by_name?: string;
  dispatcher_name?: string;
  ended_by?: string;
  active?: boolean;
  call_ended?: boolean;
  incident_id?: string;
  resolved?: boolean;
  marker_visible?: boolean;
  resolved_at?: string;
  resolved_by?: string;
  resolved_by_name?: string;
}

type SelectedMarker =
  | { type: 'incident'; data: Incident }
  | { type: 'unit'; data: ResponseUnit }
  | { type: 'sensor'; data: SensorWithThreat }
  | { type: 'mobileEmergency'; data: MobileEmergencyCall };

interface LatestDispatchInfo {
  docId: string;
  incidentId: string | null;
  status: string;
  acknowledged: boolean;
  navigationStarted: boolean;
  navigationStopped: boolean;
  cancelled: boolean;
  completed: boolean;
  resolved: boolean;
  resolvedAt: any;
  resolvedByUnit: string;
  dispatchedAtMs: number;
  isTerminal: boolean;
  derivedStatus: 'Dispatched' | 'EnRoute' | 'OnScene' | 'Available';
}

interface OSRMRouteData {
  route: Array<{ lat: number; lng: number }>;
  distance: number;
  duration: number;
  distance_text: string;
  duration_text: string;
  __fetchedAt?: number;
}

type RouteOrigin = 'caller' | 'incident' | 'sensor' | 'unit' | 'mobile';

interface AlarmAudio extends HTMLAudioElement {
  _interval?: number | null;
  _context?: AudioContext | null;
  _oscillator?: OscillatorNode | null;
  _gainNode?: GainNode | null;
  _isPlaying?: boolean;
  stop?: () => void;
}

interface SystemStatus {
  gps: 'online' | 'offline' | 'error';
  network: 'online' | 'offline' | 'error';
  emergencyBroadcast: 'active' | 'inactive' | 'error';
  lastUpdated: Date;
  ping: number;
  uptime: number;
}

interface WebRTCState {
  peerConnection: RTCPeerConnection | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
}

interface CallState {
  callId: string | null;
  isActive: boolean;
  isConnected: boolean;
  isMuted: boolean;
  isSpeakerOn: boolean;
  callDuration: number;
  callerName: string;
  callerPhone: string;
}

interface LiveRoute {
  distanceKm: number;
  etaMinutes: number;
  distanceText: string;
  etaText: string;
  fetchedAt: number;
}

interface SensorFlash {
  sensorId: string;
  startedAt: number;
}

// ============================================================
// CONSTANTS
// ============================================================
const mapContainerStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: '#1a1a2e',
};

const GOOGLE_MAPS_LIBRARIES: ('places' | 'geometry' | 'drawing' | 'visualization')[] = [
  'places',
  'geometry',
];

const FIRE_STATION_LOCATION = {
  lat: 18.26031900849349,
  lng: 121.99689251349221,
  address: "7X6W+2QF, Poblacion, Gonzaga, Cagayan, Philippines",
  name: "Gonzaga Fire Station (BFP)"
};

const defaultCenter = FIRE_STATION_LOCATION;
const OSRM_API_BASE = 'https://router.project-osrm.org';

const HEARTBEAT_TTL_MS = 2 * 60 * 1000;
const LIVE_ROUTE_TTL_MS = 60_000;
const UNIT_TICK_MS = 5_000;
const INCIDENT_LIST_LIMIT = 25;

const SENSOR_FLASH_DURATION_MS = 6_000;

const LATENCY_WINDOW = 8;

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:global.relay.metered.ca:80',
        'turn:global.relay.metered.ca:80?transport=tcp',
        'turn:global.relay.metered.ca:443',
        'turns:global.relay.metered.ca:443?transport=tcp',
      ],
      username: '72e59d5647f1bc4d016ca845',
      credential: 'jkD51TRYgTD8q6fn',
    },
  ],
  iceCandidatePoolSize: 10,
};

const dropdownStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.12)',
  color: '#ffffff',
  border: '1px solid rgba(255,255,255,0.25)',
  borderRadius: '6px',
  padding: '6px 12px',
  fontSize: '12px',
  fontWeight: '600',
  cursor: 'pointer',
  outline: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  backgroundImage: `url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3e%3cpath d='M7 10l5 5 5-5z'/%3e%3c/svg%3e")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 8px center',
  backgroundSize: '14px',
  paddingRight: '30px',
};

const dropdownOptionStyle: React.CSSProperties = {
  background: '#1a1a2e',
  color: '#ffffff',
};

// ============================================================
// DEFAULT UNITS
// ============================================================
const DEFAULT_UNITS_SEED = [
  {
    unit_id: 'UNIT-001',
    unit_code: 'U1',
    unit_name: 'Unit 1',
    status: 'Available',
    latitude: FIRE_STATION_LOCATION.lat,
    longitude: FIRE_STATION_LOCATION.lng,
  },
  {
    unit_id: 'UNIT-002',
    unit_code: 'U2',
    unit_name: 'Unit 2',
    status: 'Available',
    latitude: FIRE_STATION_LOCATION.lat,
    longitude: FIRE_STATION_LOCATION.lng,
  },
] as const;

const DEFAULT_UNITS_FALLBACK: ResponseUnit[] = DEFAULT_UNITS_SEED.map(u => ({
  ...u,
  current_incident_id: null,
} as unknown as ResponseUnit));

const BUSY_UNIT_STATUSES = ['Dispatched', 'EnRoute', 'OnScene'] as const;

// ============================================================
// UNIT ONLINE CHECK
// ============================================================
const isUnitOnline = (unit: ResponseUnit): boolean => {
  if (!isValidCoord(unit.latitude, unit.longitude)) return false;

  const explicitOnline = (unit as any).is_online;

  if (explicitOnline === false) return false;

  const now = Date.now();

  const lastActive = (unit as any).last_active as number | undefined;
  if (typeof lastActive === 'number' && lastActive > 0) {
    return now - lastActive <= HEARTBEAT_TTL_MS;
  }

  if (unit.last_update) {
    const lastUpdateMs = new Date(unit.last_update).getTime();
    if (!Number.isNaN(lastUpdateMs)) {
      return now - lastUpdateMs <= HEARTBEAT_TTL_MS;
    }
  }

  if (explicitOnline === true) return true;

  return false;
};

// ============================================================
// TERMINAL DISPATCH DETECTION
// ============================================================
const isTerminalDispatch = (d: any): boolean => {
  if (!d) return true;
  if (d.navigation_stopped === true) return true;
  if (d.cancelled === true) return true;
  if (d.completed === true) return true;
  if (d.resolved === true) return true;
  const st = (d.status || '').toLowerCase();
  if (st === 'completed' || st === 'cancelled' || st === 'canceled' || st === 'resolved') return true;
  return false;
};

const deriveDispatchStatus = (d: any): LatestDispatchInfo['derivedStatus'] => {
  if (!d) return 'Available';
  if (isTerminalDispatch(d)) return 'Available';

  const st = (d.status || '').toLowerCase();
  if (st === 'on_scene' || st === 'onscene') return 'OnScene';

  if (d.navigation_started === true || d.acknowledged === true) return 'EnRoute';

  return 'Dispatched';
};

// ============================================================
// FIRE TRUCK SVG PATH
// ============================================================
const FIRE_TRUCK_PATH =
  'M2 15h2a2 2 0 0 0 4 0h6a2 2 0 0 0 4 0h2v-3l-2-3h-4V7H6a2 2 0 0 0-2 2v6h-2zm14-5h2.5l1.5 2.5V13h-4V10zM6 17a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm10 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z';

// ============================================================
// CALLER NAME RESOLUTION
// ============================================================
const getCallerName = (data: any, fallback: string = 'Unknown Caller'): string => {
  if (!data) return fallback;
  const candidates = [
    data.caller_name, data.callerName, data.userName, data.user_name,
    data.displayName, data.display_name, data.full_name, data.fullName,
    data.fullname, data.name, data.username, data.userEmail,
    data.user_email, data.email,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const trimmed = candidate.trim();
      if (trimmed.includes('@') && !trimmed.includes(' ')) return trimmed.split('@')[0];
      return trimmed;
    }
  }
  if (data.user && typeof data.user === 'object') {
    const nested = getCallerName(data.user, '');
    if (nested) return nested;
  }
  if (data.userData && typeof data.userData === 'object') {
    const nested = getCallerName(data.userData, '');
    if (nested) return nested;
  }
  return fallback;
};

const getCallerPhone = (data: any, fallback: string = 'No caller ID'): string => {
  if (!data) return fallback;
  
  const candidates = [
    data.caller_phone, data.callerPhone, data.phone, data.phoneNumber,
    data.phone_number, data.mobile, data.mobileNumber, data.userPhone, 
    data.user_phone, data.contact_number, data.contactNumber,
    data.contact, data.phone_no, data.phoneNo, data.tel,
  ];
  
  for (const candidate of candidates) {
    // Handle string values
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim();
    }
    // Handle numeric values (e.g., 9123456789)
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return String(candidate);
    }
  }
  
  // Check nested user objects
  if (data.user && typeof data.user === 'object') {
    const nested = getCallerPhone(data.user, '');
    if (nested) return nested;
  }
  if (data.userData && typeof data.userData === 'object') {
    const nested = getCallerPhone(data.userData, '');
    if (nested) return nested;
  }
  
  return fallback;
};

// ============================================================
// REVERSE GEOCODING
// ============================================================
const addressCache = new Map<string, string>();

const getAddressFromCoords = async (lat: number, lng: number): Promise<string> => {
  const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (addressCache.has(cacheKey)) return addressCache.get(cacheKey)!;

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!response.ok) throw new Error('Reverse geocoding failed');
    const data = await response.json();

    let address = '';
    if (data.display_name) {
      const parts: string[] = [];
      if (data.address) {
        if (data.address.road || data.address.pedestrian) parts.push(data.address.road || data.address.pedestrian);
        if (data.address.barangay || data.address.suburb || data.address.neighbourhood) {
          parts.push(data.address.barangay || data.address.suburb || data.address.neighbourhood);
        }
        if (data.address.town || data.address.city || data.address.village || data.address.municipality) {
          parts.push(data.address.town || data.address.city || data.address.village || data.address.municipality);
        }
        if (data.address.state || data.address.province) parts.push(data.address.state || data.address.province);
        if (data.address.country) parts.push(data.address.country);
      }
      address = parts.length > 0 ? parts.join(', ') : data.display_name;
    } else {
      address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    addressCache.set(cacheKey, address);
    return address;
  } catch (error) {
    const fallback = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    addressCache.set(cacheKey, fallback);
    return fallback;
  }
};

// ============================================================
// HISTORY MIRROR — EMERGENCY REPORTS
// ============================================================
const mirrorEmergencyToReports = async (params: {
  userId: string;
  type: 'emergency' | 'safe';
  title: string;
  description: string;
  location: string;
  latitude: number;
  longitude: number;
  timestamp?: number;
  sourceEmergencyId?: string;
  sourceCallId?: string;
  resolvedFrom?: string;
}): Promise<void> => {
  try {
    if (!params.userId) {
      console.warn('🪞 [HistoryMirror] Missing userId — skipping mirror');
      return;
    }

    const now = params.timestamp ?? Date.now();
    const reportsRef = collection(firestore, 'reports');

    const lookupField = params.sourceEmergencyId ? 'source_emergency_id' : 'source_call_id';
    const lookupValue = params.sourceEmergencyId || params.sourceCallId;

    if (lookupValue) {
      try {
        const q = query(
          reportsRef,
          where(lookupField, '==', lookupValue),
          where('type', '==', params.type)
        );
        const existing = await getDocs(q);
        if (!existing.empty) {
          for (const docSnap of existing.docs) {
            await updateDoc(doc(firestore, 'reports', docSnap.id), {
              title: params.title,
              description: params.description,
              location: params.location,
              latitude: params.latitude,
              longitude: params.longitude,
              timestamp: now,
              updated_at: new Date().toISOString(),
            }).catch(err => console.warn('🪞 [HistoryMirror] update failed:', err));
          }
          console.log('🪞 [HistoryMirror] Updated existing', params.type, 'report for', lookupValue);
          return;
        }
      } catch (lookupErr) {
        console.warn('🪞 [HistoryMirror] lookup skipped:', lookupErr);
      }
    }

    await addDoc(reportsRef, {
      userId: params.userId,
      type: params.type,
      title: params.title,
      description: params.description,
      location: params.location,
      latitude: params.latitude,
      longitude: params.longitude,
      timestamp: now,
      source: 'dispatcher_mirror',
      source_emergency_id: params.sourceEmergencyId || null,
      source_call_id: params.sourceCallId || null,
      resolved_from: params.resolvedFrom || null,
      created_at: serverTimestamp(),
      updated_at: new Date().toISOString(),
    });

    console.log('🪞 [HistoryMirror] Wrote', params.type, 'report for', lookupValue);
  } catch (err) {
    console.error('🪞 [HistoryMirror] Failed:', err);
  }
};

const mirroredEmergencyIdsRef = new Set<string>();

const mirrorEmergencyOnce = async (emergency: MobileEmergencyCall): Promise<void> => {
  if (!emergency.userId) return;
  const key = emergency.id || emergency.callId || '';
  if (!key) return;
  if (mirroredEmergencyIdsRef.has(key)) return;
  mirroredEmergencyIdsRef.add(key);

  await mirrorEmergencyToReports({
    userId: emergency.userId,
    type: 'emergency',
    title: `Emergency Call — ${emergency.caller_name || 'Unknown Caller'}`,
    description: `Emergency call received from ${emergency.caller_name || 'Unknown Caller'}${emergency.caller_phone ? ` (${emergency.caller_phone})` : ''
      }. Status: ${emergency.status || 'Received'}.`,
    location:
      emergency.address ||
      `${emergency.latitude.toFixed(5)}, ${emergency.longitude.toFixed(5)}`,
    latitude: emergency.latitude,
    longitude: emergency.longitude,
    timestamp: emergency.timestamp,
    sourceEmergencyId: emergency.id,
    sourceCallId: emergency.callId,
  });
};

// ============================================================
// MIRROR RESOLUTION TO A "SAFE" REPORT
// ============================================================
const mirrorResolutionToSafeReport = async (params: {
  incidentId: string;
  resolvedAtIso: string;
  resolvedByUnit: string;
  dispatchDoc: any;
}): Promise<void> => {
  const { incidentId, resolvedAtIso, resolvedByUnit, dispatchDoc } = params;

  if (!incidentId) return;

  const reportsRef = collection(firestore, 'reports');

  try {
    const existing = await getDocs(
      query(
        reportsRef,
        where('resolved_from', '==', incidentId),
        where('type', '==', 'safe')
      )
    );
    if (!existing.empty) {
      console.log(
        `🛡️ [SafeMirror] Safe report already exists for incident ${incidentId} — updating timestamp`
      );
      for (const docSnap of existing.docs) {
        await updateDoc(doc(firestore, 'reports', docSnap.id), {
          timestamp: Date.now(),
          updated_at: new Date().toISOString(),
        }).catch(() => { });
      }
      return;
    }
  } catch (err) {
    console.warn('🛡️ [SafeMirror] dedupe lookup failed:', err);
  }

  let userId: string | null = null;
  let callerName = 'Unknown Caller';
  let callerPhone = '';
  let latitude = 0;
  let longitude = 0;
  let address = '';

  if (dispatchDoc) {
    userId = dispatchDoc.userId || dispatchDoc.user_id || null;
    callerName = dispatchDoc.caller_name || callerName;
    callerPhone = dispatchDoc.caller_phone || callerPhone;
    if (typeof dispatchDoc.latitude === 'number') latitude = dispatchDoc.latitude;
    if (typeof dispatchDoc.longitude === 'number') longitude = dispatchDoc.longitude;
    address = dispatchDoc.location_address || '';
  }

  if (!userId) {
    try {
      const locQuery = query(
        collection(firestore, 'emergency_locations'),
        where('incident_id', '==', incidentId),
        limit(1)
      );
      const locSnap = await getDocs(locQuery);
      if (!locSnap.empty) {
        const loc = locSnap.docs[0].data() as any;
        userId = loc.userId || loc.uid || null;
        callerName = getCallerName(loc, callerName);
        callerPhone = getCallerPhone(loc, callerPhone);
        if (typeof loc.latitude === 'number') latitude = loc.latitude;
        if (typeof loc.longitude === 'number') longitude = loc.longitude;
        address = loc.address || address;
        console.log(`🛡️ [SafeMirror] Found userId via emergency_locations: ${userId}`);
      }
    } catch (err) {
      console.warn('🛡️ [SafeMirror] emergency_locations lookup failed:', err);
    }
  }

  if (!userId) {
    try {
      const callQuery = query(
        collection(firestore, 'emergency_calls'),
        where('incident_id', '==', incidentId),
        limit(1)
      );
      const callSnap = await getDocs(callQuery);
      if (!callSnap.empty) {
        const call = callSnap.docs[0].data() as any;
        userId = call.userId || call.uid || null;
        callerName = getCallerName(call, callerName);
        callerPhone = getCallerPhone(call, callerPhone);
        if (typeof call.latitude === 'number') latitude = call.latitude;
        if (typeof call.longitude === 'number') longitude = call.longitude;
        address = call.address || address;
        console.log(`🛡️ [SafeMirror] Found userId via emergency_calls: ${userId}`);
      }
    } catch (err) {
      console.warn('🛡️ [SafeMirror] emergency_calls lookup failed:', err);
    }
  }

  if (!userId) {
    console.warn(
      `🛡️ [SafeMirror] Cannot write safe report for incident ${incidentId} — no userId found`
    );
    return;
  }

  const locationText =
    address ||
    (latitude && longitude
      ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
      : 'Unknown location');

  const now = Date.now();
  try {
    await addDoc(reportsRef, {
      userId,
      type: 'safe',
      title: `Incident Resolved — ${incidentId}`,
      description:
        `Your emergency call has been resolved by ${resolvedByUnit || 'the fire department'}. ` +
        `Incident ${incidentId} is now closed. Stay safe!`,
      location: locationText,
      latitude,
      longitude,
      timestamp: now,
      source: 'dispatcher_resolution',
      source_emergency_id: null,
      source_call_id: null,
      resolved_from: incidentId,
      resolved_by_unit: resolvedByUnit || null,
      resolved_at: resolvedAtIso,
      created_at: serverTimestamp(),
      updated_at: new Date().toISOString(),
    });

    console.log(
      `🛡️ [SafeMirror] ✅ Wrote SAFE report for user ${userId} ` +
      `(incident ${incidentId}, caller: ${callerName})`
    );
  } catch (err) {
    console.error('🛡️ [SafeMirror] Failed to write safe report:', err);
  }
};

// ============================================================
// HISTORY CLEANUP
// ============================================================
const cleanupHistoryReports = async (params: {
  sourceEmergencyId?: string;
  sourceCallId?: string;
  markSafe?: {
    title: string;
    description: string;
    location: string;
    latitude: number;
    longitude: number;
    resolvedFrom?: string;
  };
}): Promise<void> => {
  try {
    const reportsRef = collection(firestore, 'reports');
    const idsToCheck = [params.sourceEmergencyId, params.sourceCallId].filter(Boolean) as string[];

    if (idsToCheck.length === 0) {
      console.warn('🧹 [HistoryCleanup] No source id provided — skipping');
      return;
    }

    const seenDocIds = new Set<string>();

    for (const id of idsToCheck) {
      for (const field of ['source_emergency_id', 'source_call_id']) {
        try {
          const q = query(reportsRef, where(field, '==', id));
          const snapshot = await getDocs(q);

          for (const docSnap of snapshot.docs) {
            if (seenDocIds.has(docSnap.id)) continue;
            seenDocIds.add(docSnap.id);

            const docRef = doc(firestore, 'reports', docSnap.id);

            if (params.markSafe) {
              await updateDoc(docRef, {
                type: 'safe',
                title: params.markSafe.title,
                description: params.markSafe.description,
                location: params.markSafe.location,
                latitude: params.markSafe.latitude,
                longitude: params.markSafe.longitude,
                timestamp: Date.now(),
                resolved_from: params.markSafe.resolvedFrom || null,
                updated_at: new Date().toISOString(),
              });
              console.log('🧹 [HistoryCleanup] Updated report → safe:', docSnap.id);
            } else {
              await deleteDoc(docRef);
              console.log('🧹 [HistoryCleanup] Deleted report:', docSnap.id);
            }
          }
        } catch (err) {
          console.warn('🧹 [HistoryCleanup] lookup skipped for field', field, ':', err);
        }
      }
    }

    if (seenDocIds.size === 0) {
      console.log('🧹 [HistoryCleanup] No matching reports found for', idsToCheck);
    } else {
      console.log(`🧹 [HistoryCleanup] Processed ${seenDocIds.size} report(s)`);
    }
  } catch (err) {
    console.error('🧹 [HistoryCleanup] Failed:', err);
  }
};

// ============================================================
// UNIT SEEDING
// ============================================================
const seedDefaultUnitsIfEmpty = async (): Promise<void> => {
  try {
    const unitsRef = collection(firestore, 'units');
    const existing = await getDocs(unitsRef);

    if (!existing.empty) {
      console.log('🚒 [UnitSeed] Units collection already populated — skipping seed');
      return;
    }

    console.log('🚒 [UnitSeed] Seeding Unit 1 and Unit 2...');
    for (const unit of DEFAULT_UNITS_SEED) {
      await addDoc(unitsRef, {
        ...unit,
        current_incident_id: null,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });
      console.log(`🚒 [UnitSeed] Created ${unit.unit_name} (${unit.unit_code})`);
    }
    console.log('✅ [UnitSeed] Default units seeded successfully');
  } catch (err) {
    console.error('🚒 [UnitSeed] Failed to seed units:', err);
  }
};

// ============================================================
// MAP STYLES
// ============================================================
const mapOptions = {
  disableDefaultUI: true,
  zoomControl: false,
  mapTypeControl: false,
  scaleControl: false,
  streetViewControl: false,
  rotateControl: false,
  fullscreenControl: false,
  styles: [
    { elementType: "geometry", stylers: [{ color: "#1a1a2e" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#1a1a2e" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#b0b0c0" }] },
    { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#e0a870" }] },
    { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#e0a870" }] },
    { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
    { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#7db88a" }] },
    { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2a3e" }] },
    { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#21213a" }] },
    { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#c0c8d8" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3a3a4e" }] },
    { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f1f2a" }] },
    { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f5dfa8" }] },
    { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f2f3a" }] },
    { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#e0a870" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#12121e" }] },
    { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#6a7a8a" }] },
    { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#12121e" }] },
    { featureType: "road", elementType: "labels", stylers: [{ visibility: "on" }] }
  ],
};

// ============================================================
// HELPERS
// ============================================================
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

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins} min ${secs} sec`;
};

const formatCallDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

// ============================================================
// LIVE ROUTE CACHE
// ============================================================
const liveRouteCache = new Map<string, LiveRoute>();

const fetchLiveRoute = async (
  unitLat: number, unitLng: number,
  incLat: number, incLng: number,
): Promise<LiveRoute> => {
  const key = `${unitLat.toFixed(4)},${unitLng.toFixed(4)}>${incLat.toFixed(4)},${incLng.toFixed(4)}`;
  const cached = liveRouteCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < LIVE_ROUTE_TTL_MS) {
    return cached;
  }

  try {
    const url = `${OSRM_API_BASE}/route/v1/driving/${unitLng},${unitLat};${incLng},${incLat}?overview=false&steps=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route');

    const r = data.routes[0];
    const etaMinutes = Math.max(1, Math.round((r.distance / 1000) / 40 * 60));

    const live: LiveRoute = {
      distanceKm: r.distance / 1000,
      etaMinutes,
      distanceText: r.distance < 1000
        ? `${Math.round(r.distance)} m`
        : `${(r.distance / 1000).toFixed(2)} km`,
      etaText: etaMinutes < 1 ? '<1 min' : `${etaMinutes} min`,
      fetchedAt: Date.now(),
    };
    liveRouteCache.set(key, live);
    return live;
  } catch (err) {
    const straightKm = calculateDistance(unitLat, unitLng, incLat, incLng);
    const roadKm = straightKm * 1.35;
    const eta = Math.max(1, Math.round(roadKm / 40 * 60));
    const fallback: LiveRoute = {
      distanceKm: roadKm,
      etaMinutes: eta,
      distanceText: `${roadKm.toFixed(2)} km`,
      etaText: `${eta} min`,
      fetchedAt: Date.now(),
    };
    liveRouteCache.set(key, fallback);
    return fallback;
  }
};

// ============================================================
// MARKER ICONS
// ============================================================
const getIncidentIcon = (threatLevel: string, status: string): google.maps.Symbol => {
  const normalizedStatus = normalizeIncidentStatus(status);
  let fillColor = threatLevel === 'RED' ? '#ff4444' : '#ffd700';
  let scale = 16;
  if (normalizedStatus === 'Resolved') { fillColor = '#00ff88'; scale = 14; }
  if (normalizedStatus === 'Cancelled') { fillColor = '#888888'; scale = 12; }
  if (normalizedStatus === 'Verified') { fillColor = '#17a2b8'; scale = 16; }
  const circlePath: string | google.maps.SymbolPath =
    window.google?.maps?.SymbolPath
      ? window.google.maps.SymbolPath.CIRCLE
      : (0 as unknown as google.maps.SymbolPath);
  return {
    path: circlePath,
    fillColor, fillOpacity: 1,
    strokeColor: '#ffffff', strokeWeight: 4, scale,
  };
};

// ============================================================
// SENSOR ICON
// ============================================================
const getSensorIcon = (
  threatLevel?: string,
  verified?: boolean,
  flashing: boolean = false,
): google.maps.Symbol => {
  const circlePath: string | google.maps.SymbolPath =
    window.google?.maps?.SymbolPath
      ? window.google.maps.SymbolPath.CIRCLE
      : (0 as unknown as google.maps.SymbolPath);

  // ✅ VERIFIED — blue
  if (verified) {
    return {
      path: circlePath,
      fillColor: '#0d6efd',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 4,
      scale: 12,
    };
  }

  // 🟡 YELLOW — gas / smoke detected
  if (threatLevel === 'YELLOW') {
    return {
      path: circlePath,
      fillColor: '#ffc107',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3,
      scale: 15,
    };
  }

  // 🔴 RED — flame detected (flashing when fresh)
  if (threatLevel === 'RED') {
    return {
      path: circlePath,
      fillColor: flashing ? '#ff5252' : '#dc3545',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: flashing ? 7 : 5,
      scale: flashing ? 26 : 20,
    };
  }

  // 🟢 NORMAL — (fallback; not normally shown on dispatcher map)
  return {
    path: circlePath,
    fillColor: '#28a745',
    fillOpacity: 0.85,
    strokeColor: '#ffffff',
    strokeWeight: 2,
    scale: 10,
  };
};

const getUnitIcon = (status: string): google.maps.Symbol => {
  const colors: Record<string, string> = {
    Available: '#28a745', Dispatched: '#007bff', EnRoute: '#17a2b8',
    OnScene: '#fd7e14', OffDuty: '#6c757d',
  };
  const symbol: google.maps.Symbol = {
    path: FIRE_TRUCK_PATH,
    fillColor: colors[status] || '#6c757d',
    fillOpacity: 1,
    strokeColor: '#ffffff',
    strokeWeight: 1,
    scale: 1.6,
  };
  if (window.google?.maps?.Point) {
    symbol.anchor = new window.google.maps.Point(12, 12);
  }
  return symbol;
};

const getMobileEmergencyIcon = (acknowledged: boolean, verified?: boolean): google.maps.Symbol => {
  const circlePath: string | google.maps.SymbolPath =
    window.google?.maps?.SymbolPath
      ? window.google.maps.SymbolPath.CIRCLE
      : (0 as unknown as google.maps.SymbolPath);

  if (verified) {
    return {
      path: circlePath,
      fillColor: '#17a2b8', fillOpacity: 0.95,
      strokeColor: '#ffffff', strokeWeight: 4, scale: 14,
    };
  }
  if (acknowledged) {
    return {
      path: circlePath,
      fillColor: '#28a745', fillOpacity: 0.9,
      strokeColor: '#ffffff', strokeWeight: 3, scale: 12,
    };
  }
  return {
    path: circlePath,
    fillColor: '#ff4444', fillOpacity: 1,
    strokeColor: '#ffffff', strokeWeight: 6, scale: 22,
  };
};

// ============================================================
// OSRM SERVICE
// ============================================================
class OSRMService {
  private static instance: OSRMService;
  private constructor() { }
  public static getInstance(): OSRMService {
    if (!OSRMService.instance) OSRMService.instance = new OSRMService();
    return OSRMService.instance;
  }
  async getRoute(origin: { lat: number; lng: number }, destination: { lat: number; lng: number }): Promise<OSRMRouteData | null> {
    try {
      const url = `${OSRM_API_BASE}/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`OSRM API error: ${response.status}`);
      const data = await response.json();
      if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) throw new Error('No route found');
      const route = data.routes[0];
      const coordinates = route.geometry.coordinates.map((coord: number[]) => ({ lat: coord[1], lng: coord[0] }));
      return {
        route: coordinates, distance: route.distance, duration: route.duration,
        distance_text: this.formatDistance(route.distance),
        duration_text: this.formatDuration(route.duration)
      };
    } catch (error) { console.error('OSRM route request failed:', error); throw error; }
  }
  private formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }
  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)} sec`;
    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins} min${secs > 0 ? ` ${secs} sec` : ''}`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours} hr ${mins} min`;
  }
}

// ============================================================
// ROUTING MANAGER
// ============================================================
class RoutingManager {
  private osrmService: OSRMService;
  private static instance: RoutingManager;
  private constructor() { this.osrmService = OSRMService.getInstance(); }
  public static getInstance(): RoutingManager {
    if (!RoutingManager.instance) RoutingManager.instance = new RoutingManager();
    return RoutingManager.instance;
  }
  async routeBFPToIncident(incident: Incident) {
    return this.osrmService.getRoute({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng }, { lat: incident.latitude, lng: incident.longitude });
  }
  async routeBFPToMobileEmergency(location: { lat: number; lng: number }) {
    return this.osrmService.getRoute({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng }, { lat: location.lat, lng: location.lng });
  }
  async routeBFPToSensor(sensor: SensorWithThreat) {
    return this.osrmService.getRoute({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng }, { lat: sensor.latitude, lng: sensor.longitude });
  }
  async routeUnitToIncident(unit: ResponseUnit, incident: Incident) {
    return this.osrmService.getRoute({ lat: unit.latitude, lng: unit.longitude }, { lat: incident.latitude, lng: incident.longitude });
  }
}

// ============================================================
// INCOMING CALL OVERLAY
// ============================================================
interface IncomingCallOverlayProps {
  emergency: MobileEmergencyCall;
  onAcknowledge: () => void;
  onDismiss: () => void;
  onEndCall?: () => void;
  dispatcherName?: string;
  dispatcherRole?: string;
  isCallConnected?: boolean;
}

const IncomingCallOverlay: React.FC<IncomingCallOverlayProps> = ({
  emergency, onAcknowledge, onDismiss, onEndCall,
  dispatcherName = 'Dispatcher', dispatcherRole = 'Dispatcher',
  isCallConnected: externalCallConnected = false,
}) => {
  const [ringing, setRinging] = useState(true);
  const [callConnected, setCallConnected] = useState(externalCallConnected);
  const [connecting, setConnecting] = useState(false);
  const [resolvedAddress, setResolvedAddress] = useState<string>(emergency.address || '');
  const [isResolvingAddress, setIsResolvingAddress] = useState<boolean>(false);

  useEffect(() => {
    const timer = setTimeout(() => setRinging(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => { setCallConnected(externalCallConnected); }, [externalCallConnected]);

  useEffect(() => {
    let isMounted = true;
    if (!emergency.address || emergency.address.trim() === '') {
      setIsResolvingAddress(true);
      getAddressFromCoords(emergency.latitude, emergency.longitude)
        .then((addr) => { if (isMounted) { setResolvedAddress(addr); setIsResolvingAddress(false); } })
        .catch(() => { if (isMounted) { setResolvedAddress(`${emergency.latitude.toFixed(5)}, ${emergency.longitude.toFixed(5)}`); setIsResolvingAddress(false); } });
    } else { setResolvedAddress(emergency.address); }
    return () => { isMounted = false; };
  }, [emergency.address, emergency.latitude, emergency.longitude]);

  const handleAcknowledge = () => {
    setConnecting(true);
    setRinging(false);
    onAcknowledge();
  };

  const handleEndCall = () => {
    setCallConnected(false);
    setRinging(false);
    if (onEndCall) {
      onEndCall();
    } else {
      onDismiss();
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(20px)',
      zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
      animation: 'fadeIn 0.3s ease'
    }}>
      <div style={{
        backgroundColor: '#12121f', borderRadius: '20px', maxWidth: '540px', width: '92%',
        border: callConnected ? '1px solid rgba(40,167,69,0.4)' : '1px solid rgba(220,53,69,0.3)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.05)',
        overflow: 'hidden'
      }}>
        <div style={{
          padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'rgba(255,255,255,0.03)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '42px', height: '42px', borderRadius: '12px',
              backgroundColor: callConnected ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${callConnected ? 'rgba(40,167,69,0.3)' : 'rgba(220,53,69,0.3)'}`
            }}>
              {connecting ? <FaSpinner size={20} style={{ color: '#ffc107', animation: 'spin 1s linear infinite' }} />
                : callConnected ? <FaCheckCircle size={20} style={{ color: '#28a745' }} />
                  : <FaPhoneAlt size={20} style={{ color: '#dc3545' }} />}
            </div>
            <div>
              <div style={{ color: '#ffffff', fontSize: '18px', fontWeight: '700', letterSpacing: '0.3px' }}>
                {connecting ? 'Connecting...' : callConnected ? 'Call Connected' : 'Incoming Emergency Call'}
              </div>
              <div style={{
                fontSize: '13px', color: callConnected ? '#4dff88' : '#ff6b6b',
                display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600', marginTop: '2px'
              }}>
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  backgroundColor: callConnected ? '#28a745' : '#dc3545',
                  display: 'inline-block',
                  animation: !callConnected && ringing ? 'pulse 1s infinite' : 'none'
                }} />
                {callConnected ? 'ACTIVE CALL' : ringing ? 'RINGING...' : 'WAITING FOR RESPONSE'}
              </div>
            </div>
          </div>
          <div style={{
            fontSize: '12px', color: 'rgba(255,255,255,0.7)', fontWeight: '600',
            backgroundColor: 'rgba(255,255,255,0.08)', padding: '4px 12px',
            borderRadius: '20px', border: '1px solid rgba(255,255,255,0.1)'
          }}>{dispatcherRole}</div>
        </div>

        <div style={{ padding: '28px 24px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '18px' }}>
            <div style={{
              width: '64px', height: '64px', borderRadius: '50%',
              backgroundColor: callConnected ? 'rgba(40,167,69,0.15)' : 'rgba(220,53,69,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `3px solid ${callConnected ? 'rgba(40,167,69,0.3)' : 'rgba(220,53,69,0.25)'}`,
              flexShrink: 0
            }}>
              <FaUser size={28} style={{ color: callConnected ? '#28a745' : '#dc3545' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: '26px', fontWeight: '800', color: '#ffffff',
                lineHeight: '1.2', wordBreak: 'break-word', marginBottom: '6px', letterSpacing: '-0.3px'
              }}>
                {emergency.caller_name && emergency.caller_name !== 'Citizen' && emergency.caller_name !== 'Unknown Caller'
                  ? emergency.caller_name : 'Unknown Caller'}
              </div>
              <div style={{ fontSize: '16px', color: 'rgba(255,255,255,0.85)', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '500' }}>
                <FaPhone size={14} style={{ color: '#4d9aff' }} />
                {emergency.caller_phone || 'No caller ID'}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: '0 24px 24px' }}>
          <div style={{
            background: 'rgba(255,255,255,0.06)', borderRadius: '14px', padding: '20px 22px',
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' }}>
              <FaMapMarkerAlt size={18} style={{ color: '#ff4444', marginTop: '2px', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', color: '#ffffff', lineHeight: '1.6', wordBreak: 'break-word', fontWeight: '500' }}>
                  {isResolvingAddress ? (
                    <span style={{ color: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <FaSpinner size={14} className="spin" /> Resolving exact location...
                    </span>
                  ) : (resolvedAddress || 'Location unavailable')}
                </div>
              </div>
            </div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '20px',
              paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.1)'
            }}>
              {emergency.accuracy && (
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '500' }}>
                  <FaCrosshairs size={12} style={{ color: '#4d9aff' }} /> ±{emergency.accuracy.toFixed(1)}m accuracy
                </div>
              )}
              {emergency.provider && (
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '500' }}>
                  <FaSatelliteDish size={12} style={{ color: '#4d9aff' }} /> {emergency.provider}
                </div>
              )}
              <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '500' }}>
                <FaClock size={12} style={{ color: '#4d9aff' }} /> {new Date(emergency.timestamp).toLocaleTimeString()}
              </div>
            </div>
            {callConnected && (
              <div style={{
                marginTop: '16px', padding: '12px 18px',
                background: 'rgba(40,167,69,0.12)', borderRadius: '10px',
                border: '1px solid rgba(40,167,69,0.25)',
                display: 'flex', alignItems: 'center', gap: '12px'
              }}>
                <span style={{
                  width: '10px', height: '10px', borderRadius: '50%',
                  backgroundColor: '#28a745', display: 'inline-block',
                  animation: 'pulse 1s infinite',
                  boxShadow: '0 0 12px rgba(40,167,69,0.6)'
                }} />
                <span style={{ fontSize: '14px', color: '#4dff88', fontWeight: '700', letterSpacing: '0.5px' }}>
                  LIVE VOICE CONNECTION ACTIVE
                </span>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '0 24px 28px', display: 'flex', gap: '14px' }}>
          {!callConnected && !connecting ? (
            <>
              <button onClick={handleAcknowledge} disabled={connecting} style={{
                flex: 1, padding: '18px 28px', borderRadius: '14px',
                background: 'linear-gradient(135deg, #28a745, #1e7e34)',
                border: 'none', color: '#fff', fontSize: '17px', fontWeight: '700',
                cursor: connecting ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                transition: 'all 0.2s ease', opacity: connecting ? 0.7 : 1,
                boxShadow: '0 6px 24px rgba(40,167,69,0.35)', letterSpacing: '0.3px'
              }}>
                {connecting ? <FaSpinner size={20} className="spin" /> : <FaCheck size={20} />}
                {connecting ? 'Connecting...' : 'Answer'}
              </button>
              <button onClick={handleEndCall} style={{
                flex: 1, padding: '18px 28px', borderRadius: '14px',
                background: 'rgba(220,53,69,0.18)',
                border: '2px solid rgba(220,53,69,0.35)',
                color: '#ff6b6b', fontSize: '17px', fontWeight: '700', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
                transition: 'all 0.2s ease', letterSpacing: '0.3px'
              }}>
                <FaPhoneSlash size={20} /> End Call
              </button>
            </>
          ) : (
            <button onClick={handleEndCall} style={{
              width: '100%', padding: '18px 28px', borderRadius: '14px',
              background: 'rgba(220,53,69,0.18)',
              border: '2px solid rgba(220,53,69,0.35)',
              color: '#ff6b6b', fontSize: '17px', fontWeight: '700', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
              transition: 'all 0.2s ease', letterSpacing: '0.3px'
            }}>
              <FaPhoneSlash size={20} /> End Call
            </button>
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'rgba(0,0,0,0.3)'
        }}>
          <div style={{
            fontSize: '12px',
            color: callConnected ? '#4dff88' : ringing ? '#ff6b6b' : 'rgba(255,255,255,0.7)',
            fontWeight: '700', letterSpacing: '1px'
          }}>
            {callConnected ? '🔴 LIVE' : ringing ? '🔴 RINGING' : '⏳ WAITING'}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', fontWeight: '500' }}>{dispatcherName}</div>
        </div>
      </div>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </div>
  );
};

// ============================================================
// ACTIVE CALL OVERLAY
// ============================================================
interface ActiveCallOverlayProps {
  callerName: string;
  callerPhone: string;
  callDuration: number;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isConnected: boolean;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
}

const ActiveCallOverlay: React.FC<ActiveCallOverlayProps> = ({
  callerName, callerPhone, callDuration, isMuted, isSpeakerOn, isConnected,
  onEndCall, onToggleMute, onToggleSpeaker,
}) => {
  return (
    <div style={{
      position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
      backgroundColor: 'rgba(13,13,26,0.98)', borderRadius: '20px', padding: '20px 32px',
      boxShadow: '0 16px 64px rgba(0,0,0,0.8), 0 0 0 1px rgba(40,167,69,0.3)',
      zIndex: 9998, display: 'flex', alignItems: 'center', gap: '24px',
      border: '1px solid rgba(40,167,69,0.2)', animation: 'slideUp 0.3s ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '48px', height: '48px', borderRadius: '50%',
          backgroundColor: isConnected ? 'rgba(40,167,69,0.15)' : 'rgba(255,193,7,0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `2px solid ${isConnected ? 'rgba(40,167,69,0.3)' : 'rgba(255,193,7,0.3)'}`,
        }}>
          <FaUser size={20} style={{ color: isConnected ? '#28a745' : '#ffc107' }} />
        </div>
        <div>
          <div style={{ color: '#fff', fontSize: '16px', fontWeight: '700' }}>
            {callerName || 'Unknown Caller'} {callerPhone && <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', fontWeight: '400' }}>({callerPhone})</span>}
          </div>
          <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{
              width: '8px', height: '8px', borderRadius: '50%',
              backgroundColor: isConnected ? '#28a745' : '#ffc107',
              display: 'inline-block', animation: 'pulse 1.5s infinite',
            }} />
            {isConnected ? 'Connected' : 'Connecting...'} • {formatCallDuration(callDuration)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button onClick={onToggleMute} style={{
          width: '48px', height: '48px', borderRadius: '50%',
          backgroundColor: isMuted ? 'rgba(220,53,69,0.2)' : 'rgba(255,255,255,0.1)',
          border: `1px solid ${isMuted ? 'rgba(220,53,69,0.4)' : 'rgba(255,255,255,0.15)'}`,
          color: isMuted ? '#ff6b6b' : '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', transition: 'all 0.2s ease',
        }} title={isMuted ? 'Unmute' : 'Mute'}>
          {isMuted ? <FaMicrophoneSlash size={18} /> : <FaMicrophone size={18} />}
        </button>

        <button onClick={onToggleSpeaker} style={{
          width: '48px', height: '48px', borderRadius: '50%',
          backgroundColor: isSpeakerOn ? 'rgba(40,167,69,0.2)' : 'rgba(255,255,255,0.1)',
          border: `1px solid ${isSpeakerOn ? 'rgba(40,167,69,0.4)' : 'rgba(255,255,255,0.15)'}`,
          color: isSpeakerOn ? '#4dff88' : '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', transition: 'all 0.2s ease',
        }} title={isSpeakerOn ? 'Speaker On' : 'Speaker Off'}>
          {isSpeakerOn ? <FaVolumeUp size={18} /> : <FaVolumeMute size={18} />}
        </button>

        <button onClick={onEndCall} style={{
          width: '56px', height: '56px', borderRadius: '50%',
          backgroundColor: '#dc3545', border: 'none', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', boxShadow: '0 4px 20px rgba(220,53,69,0.4)',
          transition: 'all 0.2s ease',
        }} title="End Call">
          <FaPhoneSlash size={22} />
        </button>
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
};

// ============================================================
// MAIN COMPONENT
// ============================================================
const DispatcherGeoMap: React.FC = () => {
  const { user, logActivity, logout } = useAuth();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [units, setUnits] = useState<ResponseUnit[]>(DEFAULT_UNITS_FALLBACK);
  const [unitsLoaded, setUnitsLoaded] = useState<boolean>(false);
  const [sensors, setSensors] = useState<SensorWithThreat[]>([]);
  const [mobileEmergencies, setMobileEmergencies] = useState<MobileEmergencyCall[]>([]);

  const [latestDispatchByUnit, setLatestDispatchByUnit] = useState<Map<string, LatestDispatchInfo>>(new Map());

  const [showSidebar, setShowSidebar] = useState<boolean>(true);
  const [activeSidebarTab, setActiveSidebarTab] = useState<'dashboard' | 'incidents' | 'units' | 'sensors' | 'emergencies'>('dashboard');
  const [showOverlay, setShowOverlay] = useState<boolean>(true);
  const [mapZoom, setMapZoom] = useState<number>(15);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number; address?: string; name?: string }>(defaultCenter);

  const [mapLoaded, setMapLoaded] = useState<boolean>(false);
  const mapLoadedRef = useRef<boolean>(false);

  const [selectedMarker, setSelectedMarker] = useState<SelectedMarker | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [showIncidentModal, setShowIncidentModal] = useState<boolean>(false);
  const [showDispatchModal, setShowDispatchModal] = useState<boolean>(false);
  const [selectedUnits, setSelectedUnits] = useState<string[]>([]);
  const [selectedMobileEmergency, setSelectedMobileEmergency] = useState<MobileEmergencyCall | null>(null);
  const [showMobileEmergencyModal, setShowMobileEmergencyModal] = useState<boolean>(false);

  const [selectedSensor, setSelectedSensor] = useState<SensorWithThreat | null>(null);
  const [showSensorModal, setShowSensorModal] = useState<boolean>(false);

  const [unitRoutes, setUnitRoutes] = useState<Record<string, LiveRoute>>({});

  const [incomingCall, setIncomingCall] = useState<MobileEmergencyCall | null>(null);
  const [showIncomingCall, setShowIncomingCall] = useState<boolean>(false);
  const [isCallConnected, setIsCallConnected] = useState<boolean>(false);
  const incomingCallTimeoutRef = useRef<number | null>(null);
  const dismissCooldownRef = useRef<number | null>(null);
  const callStartTimeRef = useRef<number | null>(null);

  const [alarmTriggered, setAlarmTriggered] = useState<boolean>(false);
  const [iotHighThreatAlarm, setIotHighThreatAlarm] = useState<boolean>(false);
  const [highThreatSensor, setHighThreatSensor] = useState<SensorWithThreat | null>(null);
  const [showFireAlarm, setShowFireAlarm] = useState(false);

  const [gasSmokeAlarm, setGasSmokeAlarm] = useState<boolean>(false);
  const [gasSmokeSensor, setGasSmokeSensor] = useState<SensorWithThreat | null>(null);

  const [routeData, setRouteData] = useState<OSRMRouteData | null>(null);
  const [showRoute, setShowRoute] = useState<boolean>(false);
  const [routeOrigin, setRouteOrigin] = useState<{ lat: number; lng: number; name: string; type: RouteOrigin } | null>(null);
  const [routeDestination, setRouteDestination] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [routeLoading, setRouteLoading] = useState<boolean>(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeKey, setRouteKey] = useState<number>(0);

  const polylineRef = useRef<google.maps.Polyline | null>(null);
  const routeClearedRef = useRef<boolean>(false);

  const [incidentFilter, setIncidentFilter] = useState<string>('all');
  const [unitFilter, setUnitFilter] = useState<string>('all');
  const [sensorFilter, setSensorFilter] = useState<string>('all');
  const [searchQuery] = useState<string>('');

  const [processing, setProcessing] = useState<boolean>(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState<boolean>(false);
  const [showFireStationInfo, setShowFireStationInfo] = useState<boolean>(false);

  const [, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [myLocationMarker, setMyLocationMarker] = useState<google.maps.Marker | null>(null);
  const [showMyLocation, setShowMyLocation] = useState<boolean>(false);
  const [isGettingLocation, setIsGettingLocation] = useState<boolean>(false);

  const locationRequestIdRef = useRef<number>(0);

  const [unitTick, setUnitTick] = useState<number>(0);

  const [panelPosition, setPanelPosition] = useState<{ x: number; y: number }>({ x: 20, y: 20 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [socket, setSocket] = useState<Socket | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [wsReconnecting, setWsReconnecting] = useState<boolean>(false);

  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    gps: 'online', network: 'online', emergencyBroadcast: 'active',
    lastUpdated: new Date(), ping: 0, uptime: 0
  });
  const [currentTime, setCurrentTime] = useState<string>('');
  const [startTime] = useState<number>(Date.now());

  const [rtcState, setRtcState] = useState<WebRTCState>({
    peerConnection: null,
    localStream: null,
    remoteStream: null,
    isMuted: false,
    isSpeakerOn: true,
  });

  const [callState, setCallState] = useState<CallState>({
    callId: null,
    isActive: false,
    isConnected: false,
    isMuted: false,
    isSpeakerOn: true,
    callDuration: 0,
    callerName: '',
    callerPhone: '',
  });

  const mapRef = useRef<google.maps.Map | null>(null);
  const alarmAudioRef = useRef<AlarmAudio | null>(null);
  const iotAlarmAudioRef = useRef<AlarmAudio | null>(null);
  const yellowAlarmAudioRef = useRef<AlarmAudio | null>(null);
  const ringtoneAudioRef = useRef<AlarmAudio | null>(null);
  const callTimerIntervalRef = useRef<number | null>(null);
  const alarmTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const routeInfoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const clockIntervalRef = useRef<number | null>(null);
  const systemStatusIntervalRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  const previousEmergenciesRef = useRef<Map<string, MobileEmergencyCall>>(new Map());
  const processedIdsRef = useRef<Set<string>>(new Set());
  const emergencyUnsubscribesRef = useRef<(() => void)[]>([]);
  const activeIncomingCallIdRef = useRef<string | null>(null);

  const verifiedEmergencyIdsRef = useRef<Set<string>>(new Set());
  const verifiedIncidentMapRef = useRef<Map<string, string>>(new Map());
  const resolvedEmergencyIdsRef = useRef<Set<string>>(new Set());

  const deleteCooldownRef = useRef<Set<string>>(new Set());

  const hasSeededUnitsRef = useRef<boolean>(false);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callTimerRef = useRef<number | null>(null);
  const iceCandidatesQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const processedCallerCandidatesRef = useRef<Set<string>>(new Set());
  const currentCallIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const socketRef = useRef<Socket | null>(null);
  const activeCallFirestoreUnsubRef = useRef<(() => void) | null>(null);

  const incomingCallRef = useRef<MobileEmergencyCall | null>(null);

  const startWebRTCCallRef = useRef<(callId: string, callerName: string, callerPhone: string) => Promise<void>>(async () => { });
  const handleWebRTCAnswerRef = useRef<(answer: RTCSessionDescriptionInit) => Promise<void>>(async () => { });
  const handleWebRTCOfferRef = useRef<(offer: RTCSessionDescriptionInit, callId: string) => Promise<void>>(async () => { });
  const handleRemoteICECandidateRef = useRef<(candidate: RTCIceCandidateInit) => Promise<void>>(async () => { });
  const handleCallerEndedCallRef = useRef<(data: any) => void>(() => { });
  const activeCallsLookupRef = useRef<(callId: string) => MobileEmergencyCall | null>(() => null);

  const resolvedIncidentIdsRef = useRef<Set<string>>(new Set());

  const resolveSyncedDispatchIdsRef = useRef<Set<string>>(new Set());
  const incidentsDebugDumpedRef = useRef<boolean>(false);

  const liveDispatchRouteKeysRef = useRef<Map<string, string>>(new Map());
  const liveDispatchRouteDataRef = useRef<Map<string, OSRMRouteData>>(new Map());
  const liveDispatchPolylinesRef = useRef<Map<string, google.maps.Polyline>>(new Map());

  const imperativeUnitMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const imperativeUnitTargetPosRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const imperativeUnitAnimFrameRef = useRef<number | null>(null);

  const imperativeUnitHalosRef = useRef<Map<string, google.maps.Circle>>(new Map());

  const imperativeSensorMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const imperativeSensorTargetPosRef = useRef<Map<string, { lat: number; lng: number }>>(new Map());
  const imperativeSensorAnimFrameRef = useRef<number | null>(null);
  const sensorsRefForWatchdog = useRef<SensorWithThreat[]>([]);

  const sensorAckRef = useRef<Set<string>>(new Set());
  const sensorVerifiedRef = useRef<Map<string, string>>(new Map());

  const [sensorFlashes, setSensorFlashes] = useState<SensorFlash[]>([]);
  const sensorRedStateRef = useRef<Map<string, boolean>>(new Map());
  const sensorAlarmReTriggerIdsRef = useRef<Set<string>>(new Set());

  const sensorLinkByIncidentRef = useRef<Map<string, string>>(new Map());

  const snapshotLatencyRef = useRef<number[]>([]);
  const lastSnapshotAtRef = useRef<Map<string, number>>(new Map());
  const [liveLatencyMs, setLiveLatencyMs] = useState<number>(0);

  const [badgePulseKey, setBadgePulseKey] = useState<number>(0);
  const prevBadgeCountsRef = useRef<{ [k: string]: number }>({});

  const unitsRefForWatchdog = useRef<ResponseUnit[]>([]);

  const stickyYellowAlertRef = useRef<SensorWithThreat | null>(null);
  const stickyRedAlertRef = useRef<SensorWithThreat | null>(null);

  useEffect(() => {
    unitsRefForWatchdog.current = units;
  }, [units]);

  useEffect(() => {
    sensorsRefForWatchdog.current = sensors;
  }, [sensors]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  const routingManager = RoutingManager.getInstance();

  const getDispatcherName = useCallback(() => {
    if (user) {
      if (user.displayName && user.displayName.trim() !== '') return user.displayName;
      if (user.full_name && user.full_name.trim() !== '') return user.full_name;
      if (user.name && user.name.trim() !== '') return user.name;
      if (user.username && user.username.trim() !== '') return user.username;
      if (user.email) return user.email.split('@')[0];
      return 'Dispatcher';
    }
    return 'Dispatcher';
  }, [user]);

  const getDispatcherRole = useCallback(() => {
    if (user) {
      if (user.role) return user.role;
      if (user.userRole) return user.userRole;
      return 'Dispatcher';
    }
    return 'Dispatcher';
  }, [user]);

  const handleMapLoad = useCallback((map: google.maps.Map) => {
    mapRef.current = map;
    mapLoadedRef.current = true;
    setMapLoaded(true);
    console.log('✅ [Google Maps] Map instance loaded');
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).google?.maps) {
      mapLoadedRef.current = true;
      setMapLoaded(true);
      console.log('✅ [Google Maps] Cached SDK detected — mapLoaded=true');
      return;
    }

    let cancelled = false;

    const pollInterval = window.setInterval(() => {
      if (cancelled) return;
      if ((window as any).google?.maps) {
        cancelled = true;
        clearInterval(pollInterval);
        mapLoadedRef.current = true;
        setMapLoaded(true);
        console.log('✅ [Google Maps] SDK became available — mapLoaded=true');
      }
    }, 200);

    const watchdog = window.setTimeout(() => {
      if (cancelled || mapLoadedRef.current) return;
      cancelled = true;
      clearInterval(pollInterval);

      console.error(
        '❌ [Google Maps] SDK failed to load within 20s. ' +
        'Common causes:\n' +
        '  • Invalid/missing VITE_GOOGLE_MAPS_API_KEY\n' +
        '  • Maps JavaScript API not enabled in Google Cloud Console\n' +
        '  • Daily quota exhausted (demo key limit)\n' +
        '  • Script blocked by an ad blocker / Brave Shields\n' +
        '  • CSP blocking https://maps.googleapis.com'
      );

      mapLoadedRef.current = true;
      setMapLoaded(true);
    }, 20000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
      window.clearTimeout(watchdog);
    };
  }, []);

  const getDispatcherRoleText = useCallback(() => {
    if (user) {
      if (user.role) return user.role;
      if (user.userRole) return user.userRole;
      return 'Dispatcher';
    }
    return 'Dispatcher';
  }, [user]);

  useEffect(() => {
    const id = window.setInterval(() => setUnitTick(t => t + 1), UNIT_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (hasSeededUnitsRef.current) return;
    hasSeededUnitsRef.current = true;
    seedDefaultUnitsIfEmpty().catch(err =>
      console.warn('🚒 [UnitSeed] Seed attempt failed (non-fatal):', err)
    );
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const gmaps = window.google?.maps;

    const detachCurrentPolyline = () => {
      if (polylineRef.current) {
        try {
          polylineRef.current.setMap(null);
          console.log('🧹 [Route] Detached existing polyline');
        } catch (e) {
          console.warn('🧹 [Route] Failed to detach polyline:', e);
        }
        polylineRef.current = null;
      }
    };

    if (!map || !gmaps) {
      detachCurrentPolyline();
      return;
    }

    detachCurrentPolyline();

    if (!showRoute || !routeData || routeClearedRef.current) {
      return;
    }

    try {
      const path = routeData.route.map(p => ({ lat: p.lat, lng: p.lng }));
      const polyline = new gmaps.Polyline({
        path,
        strokeColor: '#0d6efd',
        strokeWeight: 4,
        strokeOpacity: 0.85,
        geodesic: true,
        zIndex: 10,
        map,
      });

      polylineRef.current = polyline;
      console.log(
        `✅ [Route] Drew polyline with ${path.length} points ` +
        `(distance ${routeData.distance_text}, ETA ${routeData.duration_text})`
      );
    } catch (e) {
      console.error('❌ [Route] Failed to draw polyline:', e);
    }
  }, [routeData, showRoute, mapLoaded, routeKey]);

  useEffect(() => {
    return () => {
      if (polylineRef.current) {
        try { polylineRef.current.setMap(null); } catch { /* ignore */ }
        polylineRef.current = null;
      }
    };
  }, []);

  const stopAlarmImmediately = useCallback(() => {
    if (alarmAudioRef.current) {
      try {
        alarmAudioRef.current.pause();
        alarmAudioRef.current.loop = false;

        const intervalId = (alarmAudioRef.current as AlarmAudio)._interval;
        if (intervalId != null) {
          clearInterval(intervalId);
          (alarmAudioRef.current as AlarmAudio)._interval = null;
        }

        alarmAudioRef.current.currentTime = 0;

        const osc = (alarmAudioRef.current as AlarmAudio)._oscillator;
        if (osc) {
          try { osc.stop(); } catch (e) { /* ignore */ }
          (alarmAudioRef.current as AlarmAudio)._oscillator = null;
        }
        (alarmAudioRef.current as AlarmAudio)._gainNode = null;
      } catch (e) {
        console.warn('Error stopping alarm:', e);
      }
    }
  }, []);

  const stopRingtone = useCallback(() => {
    if (ringtoneAudioRef.current) {
      try {
        ringtoneAudioRef.current.pause();
        ringtoneAudioRef.current.currentTime = 0;
      } catch (e) {
        console.warn('Error stopping ringtone:', e);
      }
    }
  }, []);

  const handleTriggerFireAlarm = (): void => {
    stopAlarmImmediately();

    if (alarmAudioRef.current) {
      alarmAudioRef.current.play().catch((err) => {
        console.warn('🔊 [Alarm] Play blocked:', err.message);
        const retry = () => {
          alarmAudioRef.current?.play().catch(console.error);
          document.removeEventListener('click', retry);
          document.removeEventListener('touchstart', retry);
          document.removeEventListener('keydown', retry);
        };
        document.addEventListener('click', retry, { once: true });
        document.addEventListener('touchstart', retry, { once: true });
        document.addEventListener('keydown', retry, { once: true });
      });
    }

    setShowFireAlarm(true);
    setAlarmTriggered(true);

    toast.error('🚨 FIRE STATION ALARM ACTIVATED!');
  };

  const handleStopAlarm = (): void => {
    stopAlarmImmediately();
    setShowFireAlarm(false);
    setAlarmTriggered(false);
    toast.success('Station alarm silenced');
  };

  const updateClock = useCallback(() => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    setCurrentTime(timeStr);
  }, []);

  const checkGPSSignal = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { resolve(false); return; }
      const timeoutId = setTimeout(() => resolve(false), 5000);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timeoutId); resolve(true); },
        () => { clearTimeout(timeoutId); resolve(false); },
        { timeout: 5000, enableHighAccuracy: true }
      );
    });
  }, []);

  const checkNetworkStatus = useCallback((): Promise<boolean> => {
    if (!navigator.onLine) return Promise.resolve(false);
    return fetch('https://www.google.com', { method: 'HEAD', mode: 'no-cors', cache: 'no-cache' })
      .then(() => true)
      .catch(() => fetch(`${import.meta.env.VITE_WS_URL || 'http://localhost:5000'}/api/health`, { method: 'HEAD', cache: 'no-cache' })
        .then(() => true).catch(() => false));
  }, []);

  const checkEmergencyBroadcast = useCallback((): Promise<boolean> => {
    if (socket && socket.connected) return Promise.resolve(true);
    return fetch(`${import.meta.env.VITE_WS_URL || 'http://localhost:5000'}/api/health`, { cache: 'no-cache' })
      .then(() => true).catch(() => false);
  }, [socket]);

  const updateSystemStatus = useCallback(async () => {
    const startPing = Date.now();
    try {
      const gpsOk = await checkGPSSignal();
      const networkOk = await checkNetworkStatus();
      const broadcastOk = await checkEmergencyBroadcast();
      const pingTime = Date.now() - startPing;
      setSystemStatus(() => ({
        gps: gpsOk ? 'online' : 'error', network: networkOk ? 'online' : 'error',
        emergencyBroadcast: broadcastOk ? 'active' : 'inactive',
        lastUpdated: new Date(), ping: pingTime, uptime: (Date.now() - startTime) / 1000
      }));
    } catch (error) { console.error('System status check failed:', error); }
  }, [checkGPSSignal, checkNetworkStatus, checkEmergencyBroadcast, startTime]);

  useEffect(() => {
    const createAlarmSound = (frequency: number): AlarmAudio => {
      let audioContext: AudioContext | null = null;
      let intervalId: number | null = null;
      let isPlaying = false;
      const audio = new Audio() as AlarmAudio;
      audio.loop = false;

      const playBeep = () => {
        try {
          if (!audioContext) audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          if (audioContext.state === 'suspended') audioContext.resume();
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();
          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);
          oscillator.frequency.value = frequency;
          oscillator.type = 'square';
          gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
          oscillator.start();
          oscillator.stop(audioContext.currentTime + 0.3);
          audio._oscillator = oscillator;
          audio._gainNode = gainNode;
          audio._context = audioContext;
        } catch (e) { /* ignore */ }
      };

      audio.play = () => {
        if (isPlaying) return Promise.resolve();
        isPlaying = true;
        audio._isPlaying = true;
        playBeep();
        intervalId = window.setInterval(() => {
          if (!isPlaying) { if (intervalId !== null) { clearInterval(intervalId); intervalId = null; } return; }
          playBeep();
        }, 500);
        audio._interval = intervalId;
        return Promise.resolve();
      };

      audio.pause = () => {
        isPlaying = false;
        audio._isPlaying = false;
        if (intervalId !== null) { clearInterval(intervalId); intervalId = null; audio._interval = null; }
        if (audio._oscillator) { try { audio._oscillator.stop(); } catch (e) { } audio._oscillator = null; }
        audio._gainNode = null;
      };

      (audio as any).stop = () => {
        audio.pause();
        if (audio._context && audio._context.state !== 'closed') {
          setTimeout(() => {
            try { if (audio._context && audio._context.state !== 'closed') audio._context.close(); } catch (e) { }
            audio._context = null;
          }, 1000);
        }
      };
      return audio;
    };

    const createMp3Alarm = (src: string): AlarmAudio => {
      const audio = new Audio(src) as AlarmAudio;
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = 1.0;
      audio._isPlaying = false;

      const originalPlay = audio.play.bind(audio);
      const originalPause = audio.pause.bind(audio);

      audio.play = () => {
        audio._isPlaying = true;
        return originalPlay().catch((err) => {
          console.warn(`🔊 [MP3Alarm] Play blocked for ${src}:`, err?.message);
          throw err;
        });
      };

      audio.pause = () => {
        audio._isPlaying = false;
        try {
          audio.currentTime = 0;
        } catch { /* ignore */ }
        originalPause();
      };

      (audio as any).stop = () => {
        audio._isPlaying = false;
        try {
          originalPause();
          audio.currentTime = 0;
        } catch { /* ignore */ }
      };

      return audio;
    };

    alarmAudioRef.current = createMp3Alarm('/sounds/bfp_alarm.mp3');
    iotAlarmAudioRef.current = createMp3Alarm('/sounds/flame.mp3');
    yellowAlarmAudioRef.current = createMp3Alarm('/sounds/Beep.mp3');
    ringtoneAudioRef.current = createMp3Alarm('/sounds/ringtone.mp3');

    return () => {
      if (alarmAudioRef.current) { alarmAudioRef.current.stop?.(); alarmAudioRef.current.pause(); alarmAudioRef.current = null; }
      if (iotAlarmAudioRef.current) { iotAlarmAudioRef.current.stop?.(); iotAlarmAudioRef.current.pause(); iotAlarmAudioRef.current = null; }
      if (yellowAlarmAudioRef.current) { yellowAlarmAudioRef.current.stop?.(); yellowAlarmAudioRef.current.pause(); yellowAlarmAudioRef.current = null; }
      if (ringtoneAudioRef.current) { ringtoneAudioRef.current.stop?.(); ringtoneAudioRef.current.pause(); ringtoneAudioRef.current = null; }
      if (callTimerIntervalRef.current) { clearInterval(callTimerIntervalRef.current); callTimerIntervalRef.current = null; }
      if (alarmTimerRef.current) { clearTimeout(alarmTimerRef.current); alarmTimerRef.current = null; }
      if (routeInfoWindowRef.current) { routeInfoWindowRef.current.close(); routeInfoWindowRef.current = null; }
      if (clockIntervalRef.current) { clearInterval(clockIntervalRef.current); clockIntervalRef.current = null; }
      if (systemStatusIntervalRef.current) { clearInterval(systemStatusIntervalRef.current); systemStatusIntervalRef.current = null; }
      if (pingIntervalRef.current) { clearInterval(pingIntervalRef.current); pingIntervalRef.current = null; }
      if (incomingCallTimeoutRef.current) { clearTimeout(incomingCallTimeoutRef.current); incomingCallTimeoutRef.current = null; }
      if (dismissCooldownRef.current) { clearTimeout(dismissCooldownRef.current); dismissCooldownRef.current = null; }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach(track => track.stop());
        remoteStreamRef.current = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    updateClock();
    clockIntervalRef.current = window.setInterval(updateClock, 1000);
    updateSystemStatus();
    systemStatusIntervalRef.current = window.setInterval(updateSystemStatus, 5000);
    return () => {
      if (clockIntervalRef.current) clearInterval(clockIntervalRef.current);
      if (systemStatusIntervalRef.current) clearInterval(systemStatusIntervalRef.current);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };
  }, [updateClock, updateSystemStatus]);

  useEffect(() => {
    if (showIncomingCall && incomingCall) {
      activeIncomingCallIdRef.current = incomingCall.id;
    } else {
      activeIncomingCallIdRef.current = null;
    }
  }, [showIncomingCall, incomingCall]);

  const cleanupWebRTC = useCallback(() => {
    console.log('🧹 [WebRTC] Cleaning up...');

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('🎤 [WebRTC] Stopped track:', track.label);
      });
      localStreamRef.current = null;
    }

    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach(track => track.stop());
      remoteStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    if (activeCallFirestoreUnsubRef.current) {
      activeCallFirestoreUnsubRef.current();
      activeCallFirestoreUnsubRef.current = null;
    }

    setRtcState({
      peerConnection: null,
      localStream: null,
      remoteStream: null,
      isMuted: false,
      isSpeakerOn: true,
    });

    setCallState({
      callId: null,
      isActive: false,
      isConnected: false,
      isMuted: false,
      isSpeakerOn: true,
      callDuration: 0,
      callerName: '',
      callerPhone: '',
    });

    iceCandidatesQueueRef.current = [];
    processedCallerCandidatesRef.current.clear();
    currentCallIdRef.current = null;
    isCallerRef.current = false;
    callStartTimeRef.current = null;

    console.log('🧹 [WebRTC] Cleanup complete');
  }, []);

  useEffect(() => {
    if (rtcState.remoteStream && remoteAudioRef.current) {
      console.log('🔊 [WebRTC] Remote stream available — forcing playback');
      const audio = remoteAudioRef.current;

      if (audio.srcObject !== rtcState.remoteStream) {
        audio.srcObject = rtcState.remoteStream;
      }

      audio.volume = rtcState.isSpeakerOn ? 1.0 : 0.3;
      audio.muted = false;

      const attemptPlay = () => {
        audio.play()
          .then(() => console.log('✅ [WebRTC] Remote audio playing from effect'))
          .catch(err => {
            console.warn('🔇 [WebRTC] Autoplay blocked, retrying on interaction:', err.message);
            const retry = () => {
              audio.play().then(() => {
                console.log('✅ [WebRTC] Remote audio playing after interaction');
                document.removeEventListener('click', retry);
                document.removeEventListener('touchstart', retry);
                document.removeEventListener('keydown', retry);
              }).catch(console.error);
            };
            document.addEventListener('click', retry, { once: true });
            document.addEventListener('touchstart', retry, { once: true });
            document.addEventListener('keydown', retry, { once: true });
          });
      };

      attemptPlay();
      setTimeout(attemptPlay, 500);
      setTimeout(attemptPlay, 1500);
    }
  }, [rtcState.remoteStream, rtcState.isSpeakerOn]);

  useEffect(() => {
    const resumeAudio = () => {
      if (remoteAudioRef.current && remoteAudioRef.current.paused && remoteAudioRef.current.srcObject) {
        remoteAudioRef.current.play().catch(console.error);
      }
    };

    document.addEventListener('click', resumeAudio);
    document.addEventListener('touchstart', resumeAudio);
    document.addEventListener('keydown', resumeAudio);

    return () => {
      document.removeEventListener('click', resumeAudio);
      document.removeEventListener('touchstart', resumeAudio);
      document.removeEventListener('keydown', resumeAudio);
    };
  }, []);

  const stopCallTimer = useCallback(() => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
      console.log('⏱️ [Dispatcher] Call timer stopped');
    }
  }, []);

  const startCallTimer = useCallback(() => {
    if (callTimerRef.current !== null) {
      console.log('⏱️ [Dispatcher] Timer already running, skipping');
      return;
    }
    console.log('⏱️ [Dispatcher] Starting call timer');
    setCallState(prev => ({ ...prev, callDuration: 0, isConnected: true, isActive: true }));
    callTimerRef.current = window.setInterval(() => {
      setCallState(prev => ({
        ...prev,
        callDuration: prev.callDuration + 1,
      }));
    }, 1000);
  }, []);

  const initializePeerConnection = useCallback(async (callId: string, isInitiator: boolean): Promise<RTCPeerConnection> => {
    console.log('🎤 [WebRTC] Initializing peer connection for call:', callId, 'initiator:', isInitiator);

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const cand = event.candidate.toJSON();
        if (socketRef.current?.connected) {
          console.log('🧊 [WebRTC] Sending ICE candidate via socket');
          socketRef.current.emit('webrtc_ice_candidate', {
            callId,
            candidate: cand,
            from: 'dispatcher',
          });
        }
        updateDoc(doc(firestore, 'emergency_calls', callId), {
          dispatcher_ice_candidates: arrayUnion(cand)
        }).catch(() => { });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('🔗 [WebRTC] Connection state:', pc.connectionState);

      if (pc.connectionState === 'connected') {
        setCallState(prev => ({ ...prev, isConnected: true, isActive: true }));
        setRtcState(prev => ({ ...prev, peerConnection: pc }));
        toast.success('🔊 Voice connection established!');

        if (callTimerRef.current === null) {
          startCallTimer();
        }

        if (socketRef.current?.connected) {
          socketRef.current.emit('webrtc_connected', { callId });
          console.log('📤 [WebRTC] Emitted webrtc_connected to server');
        }
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        console.log('❌ [WebRTC] Connection lost');
        setCallState(prev => ({ ...prev, isConnected: false }));
      }
    };

    pc.ontrack = (event) => {
      console.log('🔊 [WebRTC] Received remote track:', event.track.kind, 'id:', event.track.id);

      const remoteStream = new MediaStream();
      remoteStream.addTrack(event.track);

      if (event.streams && event.streams.length > 0) {
        event.streams[0].getTracks().forEach(track => {
          if (!remoteStream.getTracks().find(t => t.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      }

      remoteStreamRef.current = remoteStream;
      setRtcState(prev => ({ ...prev, remoteStream }));

      const audio = remoteAudioRef.current;
      if (audio) {
        audio.srcObject = null;
        audio.srcObject = remoteStream;
        audio.volume = 1.0;
        audio.muted = false;
        audio.autoplay = true;

        const attemptPlay = (attemptNum: number) => {
          audio.play()
            .then(() => {
              console.log(`✅ [WebRTC] Remote audio playing (attempt ${attemptNum})`);
              if (callTimerRef.current === null) {
                startCallTimer();
              }
            })
            .catch(err => {
              console.warn(`🔇 [WebRTC] Play blocked (attempt ${attemptNum}):`, err.message);

              const playOnInteraction = () => {
                audio.play()
                  .then(() => {
                    console.log('✅ [WebRTC] Remote audio playing after user interaction');
                    if (callTimerRef.current === null) {
                      startCallTimer();
                    }
                    document.removeEventListener('click', playOnInteraction);
                    document.removeEventListener('touchstart', playOnInteraction);
                    document.removeEventListener('keydown', playOnInteraction);
                  })
                  .catch(console.error);
              };

              document.addEventListener('click', playOnInteraction, { once: true });
              document.addEventListener('touchstart', playOnInteraction, { once: true });
              document.addEventListener('keydown', playOnInteraction, { once: true });
            });
        };

        attemptPlay(1);
        setTimeout(() => attemptPlay(2), 300);
        setTimeout(() => attemptPlay(3), 800);
        setTimeout(() => attemptPlay(4), 1500);
        setTimeout(() => attemptPlay(5), 3000);
      } else {
        console.error('❌ [WebRTC] remoteAudioRef is NULL!');
      }

      if (callTimerRef.current === null) {
        startCallTimer();
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('🧊 [WebRTC] ICE connection state:', pc.iceConnectionState);

      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setCallState(prev => ({ ...prev, isConnected: true, isActive: true }));

        if (callTimerRef.current === null) {
          startCallTimer();
        }

        if (socketRef.current?.connected && callId) {
          socketRef.current.emit('webrtc_connected', { callId });
          console.log('📤 [WebRTC] Emitted webrtc_connected (ICE) to server');
        }
      } else if (pc.iceConnectionState === 'failed') {
        console.log('❌ [WebRTC] ICE failed — attempting restart');
        try { pc.restartIce(); } catch (e) { console.error('restartIce failed:', e); }
      } else if (pc.iceConnectionState === 'disconnected') {
        console.log('⚠️ [WebRTC] ICE disconnected — waiting for recovery');
        setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected' && callId) {
            console.log('❌ [WebRTC] ICE still disconnected — restarting');
            try { pc.restartIce(); } catch (e) { console.error('restartIce failed:', e); }
          }
        }, 3000);
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [startCallTimer]);

  const setupLocalAudio = useCallback(async (pc: RTCPeerConnection): Promise<MediaStream> => {
    console.log('🎤 [WebRTC] Requesting microphone access...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });

      console.log('🎤 [WebRTC] Got mic stream:', stream.getAudioTracks().length, 'tracks');
      localStreamRef.current = stream;
      setRtcState(prev => ({ ...prev, localStream: stream }));

      const audioTracks = stream.getAudioTracks();
      audioTracks.forEach(track => {
        console.log('🎤 [WebRTC] Adding track:', track.label, 'enabled:', track.enabled);
        track.enabled = true;
        pc.addTrack(track, stream);
      });

      return stream;
    } catch (error) {
      console.error('🎤 [WebRTC] Mic failed:', error);
      toast.error('Microphone access denied. Please allow microphone access for voice calls.');
      throw error;
    }
  }, []);

  const startWebRTCCall = useCallback(async (callId: string, callerName: string, callerPhone: string): Promise<void> => {
    console.log('📞 [WebRTC] Starting WebRTC call as dispatcher for:', callId);

    callStartTimeRef.current = Date.now();
    iceCandidatesQueueRef.current = [];
    processedCallerCandidatesRef.current.clear();

    try {
      currentCallIdRef.current = callId;
      isCallerRef.current = true;

      try {
        await updateDoc(doc(firestore, 'emergency_calls', callId), {
          status: 'Connected',
          dispatcher_ice_candidates: [],
          caller_ice_candidates: [],
          webrtc_answer: null,
        });
        console.log('🔥 [WebRTC] Reset candidate arrays in Firestore emergency_calls');
      } catch (err) {
        console.warn('Initial emergency_calls reset skipped:', err);
      }

      const pc = await initializePeerConnection(callId, true);
      await setupLocalAudio(pc);

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      await pc.setLocalDescription(offer);
      console.log('📤 [WebRTC] Sending offer');

      if (socketRef.current?.connected) {
        socketRef.current.emit('webrtc_offer', {
          callId,
          offer: {
            type: offer.type,
            sdp: offer.sdp,
          },
          from: 'dispatcher',
        });
        socketRef.current.emit('webrtc_ready', { callId });
      }

      try {
        await updateDoc(doc(firestore, 'emergency_calls', callId), {
          webrtc_offer: {
            type: offer.type,
            sdp: offer.sdp,
          },
          status: 'Connected',
        });
        console.log('🔥 [WebRTC] Offer persisted to Firestore emergency_calls');
      } catch (err) {
        console.warn('Failed to write offer to Firestore:', err);
      }

      if (activeCallFirestoreUnsubRef.current) {
        activeCallFirestoreUnsubRef.current();
        activeCallFirestoreUnsubRef.current = null;
      }

      let hasHandledAnswer = false;
      const processedFirestoreCandidates = new Set<string>();

      const unsub = onSnapshot(doc(firestore, 'emergency_calls', callId), async (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();

        if (data.webrtc_answer && !hasHandledAnswer) {
          hasHandledAnswer = true;
          console.log('🔥 [WebRTC-Firestore] Received answer from mobile:', data.webrtc_answer);
          try {
            await handleWebRTCAnswerRef.current(data.webrtc_answer);
          } catch (err) {
            console.error('🔥 [WebRTC-Firestore] Error handling answer:', err);
          }
        }

        if (Array.isArray(data.caller_ice_candidates)) {
          for (const cand of data.caller_ice_candidates) {
            if (cand && cand.candidate) {
              const candKey = `${cand.candidate}|${cand.sdpMid}|${cand.sdpMLineIndex}`;
              if (!processedFirestoreCandidates.has(candKey)) {
                processedFirestoreCandidates.add(candKey);
                console.log('🔥 [WebRTC-Firestore] Adding caller ICE candidate');
                await handleRemoteICECandidateRef.current(cand);
              }
            }
          }
        }

        if (data.status === 'Ended' && (data.ended_by === 'caller' || data.call_ended)) {
          console.log('🔥 [WebRTC-Firestore] Caller ended call in Firestore');
          handleCallerEndedCallRef.current({
            callId,
            userName: data.ended_by_name || data.caller_name || 'Caller',
          });
        }
      }, (err) => {
        console.error('🔥 [WebRTC-Firestore] Snapshot listener error:', err);
      });

      activeCallFirestoreUnsubRef.current = unsub;

      setCallState({
        callId,
        isActive: true,
        isConnected: false,
        isMuted: false,
        isSpeakerOn: true,
        callDuration: 0,
        callerName,
        callerPhone,
      });

    } catch (error) {
      console.error('📞 [WebRTC] Failed to start call:', error);
      if (activeCallFirestoreUnsubRef.current) {
        try { activeCallFirestoreUnsubRef.current(); } catch (e) { /* ignore */ }
        activeCallFirestoreUnsubRef.current = null;
      }
      toast.error('Failed to start voice call');
      throw error;
    }
  }, [initializePeerConnection, setupLocalAudio]);

  const handleWebRTCAnswer = useCallback(async (answer: RTCSessionDescriptionInit): Promise<void> => {
    console.log('📥 [WebRTC] Received answer');

    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('📥 [WebRTC] No peer connection for answer');
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('✅ [WebRTC] Remote description set from answer');

      while (iceCandidatesQueueRef.current.length > 0) {
        const candidate = iceCandidatesQueueRef.current.shift();
        if (candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('🧊 [WebRTC] Added queued ICE candidate');
        }
      }

      if (callTimerRef.current === null) {
        startCallTimer();
      }
    } catch (error) {
      console.error('📥 [WebRTC] Failed to set remote description:', error);
    }
  }, [startCallTimer]);

  const handleWebRTCOffer = useCallback(async (offer: RTCSessionDescriptionInit, callId: string): Promise<void> => {
    console.log('📥 [WebRTC] Received offer from mobile');

    callStartTimeRef.current = Date.now();
    iceCandidatesQueueRef.current = [];
    processedCallerCandidatesRef.current.clear();

    try {
      currentCallIdRef.current = callId;
      isCallerRef.current = false;

      const pc = await initializePeerConnection(callId, false);
      await setupLocalAudio(pc);

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      console.log('✅ [WebRTC] Remote description set from offer');

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('📤 [WebRTC] Sending answer');

      if (socketRef.current?.connected) {
        socketRef.current.emit('webrtc_answer', {
          callId,
          answer: {
            type: answer.type,
            sdp: answer.sdp,
          },
          from: 'dispatcher',
        });
        socketRef.current.emit('webrtc_ready', { callId });
      }

      while (iceCandidatesQueueRef.current.length > 0) {
        const candidate = iceCandidatesQueueRef.current.shift();
        if (candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('🧊 [WebRTC] Added queued ICE candidate');
        }
      }

      setCallState(prev => ({
        ...prev,
        callId,
        isActive: true,
        isConnected: true,
        callerName: prev.callerName || 'Caller',
        callerPhone: prev.callerPhone || '',
      }));

      setIsCallConnected(true);

      if (callTimerRef.current === null) {
        startCallTimer();
      }

    } catch (error) {
      console.error('📥 [WebRTC] Failed to handle offer:', error);
    }
  }, [initializePeerConnection, setupLocalAudio, startCallTimer]);

  const handleRemoteICECandidate = useCallback(async (candidate: RTCIceCandidateInit): Promise<void> => {
    if (!candidate || !candidate.candidate) return;

    const candKey = `${candidate.candidate}|${candidate.sdpMid}|${candidate.sdpMLineIndex}`;
    if (processedCallerCandidatesRef.current.has(candKey)) {
      return;
    }
    processedCallerCandidatesRef.current.add(candKey);

    console.log('🧊 [WebRTC] Received ICE candidate');

    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      console.log('🧊 [WebRTC] Remote description not ready, queueing ICE candidate');
      iceCandidatesQueueRef.current.push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log('✅ [WebRTC] ICE candidate added');
    } catch (error) {
      console.error('🧊 [WebRTC] Failed to add ICE candidate:', error);
      iceCandidatesQueueRef.current.push(candidate);
    }
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const audioTracks = stream.getAudioTracks();
    const newMutedState = !rtcState.isMuted;

    audioTracks.forEach(track => {
      track.enabled = !newMutedState;
    });

    setRtcState(prev => ({ ...prev, isMuted: newMutedState }));
    setCallState(prev => ({ ...prev, isMuted: newMutedState }));

    toast.success(newMutedState ? '🔇 Microphone muted' : '🎤 Microphone unmuted');
  }, [rtcState.isMuted]);

  const toggleSpeaker = useCallback(() => {
    const newSpeakerState = !rtcState.isSpeakerOn;
    setRtcState(prev => ({ ...prev, isSpeakerOn: newSpeakerState }));
    setCallState(prev => ({ ...prev, isSpeakerOn: newSpeakerState }));

    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = newSpeakerState ? 1.0 : 0.3;
      if (newSpeakerState && remoteAudioRef.current.paused) {
        remoteAudioRef.current.play().catch(console.error);
      }
    }

    toast.success(newSpeakerState ? '🔊 Speaker on' : '🔉 Speaker off');
  }, [rtcState.isSpeakerOn]);

  const handleCallerEndedCall = useCallback((data: any) => {
    const callId = data?.callId || data?.call_id || currentCallIdRef.current || incomingCallRef.current?.callId || incomingCallRef.current?.id;
    const callerName = data?.userName || data?.caller_name || data?.name || incomingCallRef.current?.caller_name || 'Caller';

    console.log('📞 [DISPATCHER] Caller ended the call — auto-acknowledging:', data);

    stopRingtone();
    if (incomingCallTimeoutRef.current) {
      clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = null;
    }

    setCallState({
      callId: null,
      isActive: false,
      isConnected: false,
      isMuted: false,
      isSpeakerOn: true,
      callDuration: 0,
      callerName: '',
      callerPhone: '',
    });
    setRtcState({
      peerConnection: null,
      localStream: null,
      remoteStream: null,
      isMuted: false,
      isSpeakerOn: true,
    });

    cleanupWebRTC();

    activeIncomingCallIdRef.current = null;
    currentCallIdRef.current = null;
    isCallerRef.current = false;
    iceCandidatesQueueRef.current = [];

    if (callId) {
      processedIdsRef.current.add(callId);
    }

    if (callId) {
      const existing = previousEmergenciesRef.current.get(callId);
      if (existing) {
        previousEmergenciesRef.current.set(callId, {
          ...existing,
          acknowledged: true,
          status: 'Ended',
        });
      } else {
        previousEmergenciesRef.current.set(callId, {
          id: callId,
          callId,
          latitude: 0,
          longitude: 0,
          timestamp: Date.now(),
          status: 'Ended',
          source: 'mobile_app',
          acknowledged: true,
          caller_name: callerName,
        });
      }
    }

    setMobileEmergencies(prev => prev.map(e => {
      const matches = e.id === callId || e.callId === callId;
      if (!matches) return e;
      return {
        ...e,
        acknowledged: true,
        status: 'Ended',
        acknowledged_at: e.acknowledged_at || new Date().toISOString(),
        acknowledged_by: e.acknowledged_by || 'caller',
        acknowledged_by_name: e.acknowledged_by_name || `${callerName} (ended call)`,
      };
    }));

    setShowIncomingCall(false);
    setIsCallConnected(false);
    setIncomingCall(null);

    toast(`📞 ${callerName} ended the call — auto-acknowledged`, {
      duration: 4000,
      icon: '📞'
    });
  }, [stopRingtone, cleanupWebRTC]);

  useEffect(() => {
    if (!incomingCall && !callState.isActive && !callState.callId) return;

    const activeCallId = callState.callId || incomingCall?.callId || incomingCall?.id;
    if (!activeCallId) return;

    const CALL_START_GRACE_MS = 8000;
    if (callStartTimeRef.current && Date.now() - callStartTimeRef.current < CALL_START_GRACE_MS) {
      console.log('🔵 [Auto-Close] Within grace period — skipping');
      return;
    }

    const latest = mobileEmergencies.find(
      e => e.id === activeCallId || e.callId === activeCallId ||
        e.id === incomingCall?.id || e.callId === incomingCall?.callId
    );

    if (!latest) {
      if (callState.isActive) {
        console.log('🔵 [Auto-Close] No matching emergency found, but call is active — skipping');
      }
      return;
    }

    const terminalStatuses = ['ended', 'dismissed', 'cancelled', 'canceled', 'completed', 'rejected'];
    const isTerminal = terminalStatuses.includes((latest.status || '').toLowerCase());
    const endedByCaller = latest.ended_by === 'caller' || latest.ended_by === 'user';
    const isInactive = latest.active === false;
    const isCallEnded = latest.call_ended === true;

    if (isTerminal || endedByCaller || isInactive || isCallEnded) {
      console.log('🔴 [Auto-Close] Emergency', activeCallId,
        'is terminal/ended — closing ActiveCallOverlay');

      setCallState({
        callId: null, isActive: false, isConnected: false, isMuted: false,
        isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
      });
      setRtcState({
        peerConnection: null, localStream: null, remoteStream: null,
        isMuted: false, isSpeakerOn: true,
      });
      setShowIncomingCall(false);
      setIsCallConnected(false);
      setIncomingCall(null);
      activeIncomingCallIdRef.current = null;
      currentCallIdRef.current = null;
      processedIdsRef.current.add(activeCallId);
      cleanupWebRTC();
    }
  }, [mobileEmergencies, incomingCall, callState.isActive, callState.callId, cleanupWebRTC]);

  useEffect(() => {
    if (!callState.isActive) return;

    const watchdog = setInterval(() => {
      const activeCallId = callState.callId || incomingCall?.callId || incomingCall?.id;
      if (!activeCallId) return;

      const CALL_START_GRACE_MS = 10000;
      if (callStartTimeRef.current && Date.now() - callStartTimeRef.current < CALL_START_GRACE_MS) {
        return;
      }

      const stillExists = mobileEmergencies.some(
        e => (e.id === activeCallId || e.callId === activeCallId) &&
          (e.status || '').toLowerCase() !== 'ended' &&
          (e.status || '').toLowerCase() !== 'dismissed' &&
          e.active !== false &&
          e.call_ended !== true
      );

      if (!stillExists && mobileEmergencies.length > 0) {
        console.log('🔴 [Watchdog] Call', activeCallId, 'no longer active — force-closing');
        setCallState({
          callId: null, isActive: false, isConnected: false, isMuted: false,
          isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
        });
        setRtcState({
          peerConnection: null, localStream: null, remoteStream: null,
          isMuted: false, isSpeakerOn: true,
        });
        setShowIncomingCall(false);
        setIsCallConnected(false);
        setIncomingCall(null);
        activeIncomingCallIdRef.current = null;
        currentCallIdRef.current = null;
        processedIdsRef.current.add(activeCallId);
        cleanupWebRTC();
      }
    }, 3000);

    return () => clearInterval(watchdog);
  }, [callState.isActive, callState.callId, incomingCall, mobileEmergencies, cleanupWebRTC]);

  useEffect(() => {
    if (!callState.isActive) return;
    if (callState.isConnected) return;

    const watchdog = setTimeout(() => {
      if (callState.isActive && !callState.isConnected) {
        console.log('🐕 [Dispatcher Watchdog] Call active but not connected after 5s — forcing connected + timer');
        setCallState(prev => ({ ...prev, isConnected: true }));
        if (callTimerRef.current === null) {
          startCallTimer();
        }
        setIsCallConnected(true);
      }
    }, 5000);

    return () => clearTimeout(watchdog);
  }, [callState.isActive, callState.isConnected, startCallTimer]);

  useEffect(() => {
    if (!callState.isActive || !callState.callId) return;

    const activeCallId = callState.callId;
    console.log('🔥 [WebRTC-Firestore] Subscribing to call doc for signaling:', activeCallId);

    const callDocRef = doc(firestore, 'emergency_calls', activeCallId);
    const unsubscribe = onSnapshot(callDocRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();

      if (data.webrtc_answer && peerConnectionRef.current) {
        const pc = peerConnectionRef.current;
        if (!pc.remoteDescription && data.webrtc_answer.sdp) {
          console.log('🔥 [WebRTC-Firestore] Received remote answer from Firestore');
          handleWebRTCAnswer(data.webrtc_answer);
        }
      }

      if (data.caller_ice_candidates && Array.isArray(data.caller_ice_candidates)) {
        data.caller_ice_candidates.forEach((cand: any) => {
          if (cand) {
            handleRemoteICECandidate(cand);
          }
        });
      }

      if (data.call_ended || data.status === 'Ended' || data.active === false) {
        if (data.ended_by === 'caller') {
          handleCallerEndedCall({
            callId: activeCallId,
            callerName: data.ended_by_name || 'Caller',
            reason: 'Caller ended call',
          });
        }
      }
    });

    return () => {
      console.log('🔥 [WebRTC-Firestore] Unsubscribed from call doc:', activeCallId);
      unsubscribe();
    };
  }, [callState.isActive, callState.callId, handleWebRTCAnswer, handleRemoteICECandidate, handleCallerEndedCall]);

  useEffect(() => {
    emergencyUnsubscribesRef.current.forEach(unsub => unsub());
    emergencyUnsubscribesRef.current = [];

    const locationsQuery = query(collection(firestore, 'emergency_locations'), orderBy('timestamp', 'desc'));

    const unsubscribeLocations = onSnapshot(
      locationsQuery,
      async (snapshot) => {
        const emergencies: MobileEmergencyCall[] = [];
        const newUnacknowledged: MobileEmergencyCall[] = [];

        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (hasValidCoords(data)) {
            let address = data.address || '';
            if (!address || address.trim() === '') address = await getAddressFromCoords(data.latitude, data.longitude);

            const isAcknowledged = data.acknowledged === true;
            const isResolved = data.resolved === true || data.marker_visible === false;

            const emergency: MobileEmergencyCall = {
              id: docSnap.id, callId: data.callId || docSnap.id,
              userId: data.userId || data.uid || '',
              caller_name: getCallerName(data), caller_phone: getCallerPhone(data, ''),
              latitude: data.latitude, longitude: data.longitude,
              timestamp: data.timestamp || Date.now(), address,
              status: data.status || 'Received', source: data.source || 'mobile_app',
              acknowledged: isAcknowledged,
              verified: data.verified === true,
              verified_at: data.verified_at,
              verified_by: data.verified_by,
              verified_by_name: data.verified_by_name,
              accuracy: data.accuracy, provider: data.provider,
              acknowledged_at: data.acknowledged_at, acknowledged_by: data.acknowledged_by,
              acknowledged_by_name: data.acknowledged_by_name || data.dispatcher_name || data.dispatcherName,
              dispatcher_name: data.dispatcher_name || data.dispatcherName || data.acknowledged_by_name,
              ended_by: data.ended_by, active: data.active, call_ended: data.call_ended,
              incident_id: isResolved ? undefined : data.incident_id,
              resolved: isResolved,
              marker_visible: data.marker_visible,
              resolved_at: data.resolved_at,
              resolved_by: data.resolved_by,
              resolved_by_name: data.resolved_by_name,
            };
            emergencies.push(emergency);

            mirrorEmergencyOnce(emergency).catch(err =>
              console.warn('🪞 [HistoryMirror] emergency mirror failed:', err)
            );

            const currentlyShowing = activeIncomingCallIdRef.current === docSnap.id;
            const previouslyAcknowledged = previousEmergenciesRef.current.get(docSnap.id)?.acknowledged === true;

            if (!emergency.acknowledged && !processedIdsRef.current.has(docSnap.id) && !currentlyShowing && !previouslyAcknowledged) {
              newUnacknowledged.push(emergency);
              processedIdsRef.current.add(docSnap.id);
            }
          }
        }

        const mergedEmergencies = emergencies.map(e => {
          const prevById = previousEmergenciesRef.current.get(e.id);
          const prevByCallId = e.callId ? previousEmergenciesRef.current.get(e.callId) : null;
          const prev = prevById || prevByCallId;

          const stickyVerified =
            verifiedEmergencyIdsRef.current.has(e.id) ||
            (e.callId ? verifiedEmergencyIdsRef.current.has(e.callId) : false);

          const isAcknowledged = e.acknowledged === true || prev?.acknowledged === true || stickyVerified;
          const isVerified =
            e.verified === true ||
            stickyVerified ||
            prev?.verified === true ||
            e.status === 'Verified';

          const stickyResolved =
            e.resolved === true ||
            prev?.resolved === true ||
            e.marker_visible === false ||
            prev?.marker_visible === false ||
            resolvedEmergencyIdsRef.current.has(e.id) ||
            (e.callId ? resolvedEmergencyIdsRef.current.has(e.callId) : false);

          const stickyIncidentId = stickyResolved
            ? undefined
            : (e.incident_id ||
              verifiedIncidentMapRef.current.get(e.id) ||
              (e.callId ? verifiedIncidentMapRef.current.get(e.callId) : undefined) ||
              prev?.incident_id);

          return {
            ...e,
            acknowledged: isAcknowledged,
            verified: isVerified,
            incident_id: stickyIncidentId,
            resolved: stickyResolved,
            marker_visible: stickyResolved ? false : e.marker_visible,
            resolved_at: e.resolved_at || prev?.resolved_at,
            resolved_by: e.resolved_by || prev?.resolved_by,
            resolved_by_name: e.resolved_by_name || prev?.resolved_by_name,
            verified_at: e.verified_at || prev?.verified_at,
            verified_by: e.verified_by || prev?.verified_by,
            verified_by_name: e.verified_by_name || prev?.verified_by_name,
            acknowledged_at: e.acknowledged_at || prev?.acknowledged_at,
            acknowledged_by: e.acknowledged_by || prev?.acknowledged_by,
            acknowledged_by_name: e.acknowledged_by_name || prev?.acknowledged_by_name,
            status: stickyResolved
              ? (e.status === 'Cancelled' ? 'Cancelled' : 'Resolved')
              : (isVerified ? 'Verified' : (e.status || prev?.status || 'Received')),
          };
        });

        setMobileEmergencies(mergedEmergencies);

        if (newUnacknowledged.length > 0) {
          newUnacknowledged.sort((a, b) => b.timestamp - a.timestamp);
          const newest = newUnacknowledged[0];
          if (!hasValidCoords(newest)) return;

          const existingCall = previousEmergenciesRef.current.get(newest.id);
          if (!existingCall || existingCall.acknowledged !== newest.acknowledged) {
            previousEmergenciesRef.current.set(newest.id, newest);
            activeIncomingCallIdRef.current = newest.id;
            setIncomingCall(newest);
            setShowIncomingCall(true);
            setIsCallConnected(false);
            if (ringtoneAudioRef.current) ringtoneAudioRef.current.play().catch(() => { });
            toast.error(`📞 INCOMING EMERGENCY CALL from ${newest.caller_name || 'Unknown Caller'}!`, { duration: 10000, icon: '📞' });
            if (incomingCallTimeoutRef.current) clearTimeout(incomingCallTimeoutRef.current);
            incomingCallTimeoutRef.current = window.setTimeout(() => {
              stopRingtone();
              setShowIncomingCall(false);
              activeIncomingCallIdRef.current = null;
              window.setTimeout(() => setIncomingCall(null), 500);
            }, 30000);
            if (mapRef.current) {
              mapRef.current.panTo({ lat: newest.latitude, lng: newest.longitude });
              mapRef.current.setZoom(16);
            }
          }
        }

        const newMap = new Map<string, MobileEmergencyCall>();
        mergedEmergencies.forEach(e => {
          const existingById = previousEmergenciesRef.current.get(e.id);
          const existingByCallId = e.callId ? previousEmergenciesRef.current.get(e.callId) : null;
          const existing = existingById || existingByCallId;

          const stickyVerified =
            e.verified === true ||
            verifiedEmergencyIdsRef.current.has(e.id) ||
            (e.callId ? verifiedEmergencyIdsRef.current.has(e.callId) : false) ||
            existing?.verified === true;

          const stickyResolved =
            e.resolved === true ||
            existing?.resolved === true ||
            e.marker_visible === false ||
            existing?.marker_visible === false ||
            resolvedEmergencyIdsRef.current.has(e.id) ||
            (e.callId ? resolvedEmergencyIdsRef.current.has(e.callId) : false);

          const stickyIncidentId = stickyResolved
            ? undefined
            : (e.incident_id ||
              verifiedIncidentMapRef.current.get(e.id) ||
              (e.callId ? verifiedIncidentMapRef.current.get(e.callId) : undefined) ||
              existing?.incident_id);

          const sticky: MobileEmergencyCall = {
            ...e,
            acknowledged: e.acknowledged || existing?.acknowledged || false,
            verified: stickyVerified,
            incident_id: stickyIncidentId,
            resolved: stickyResolved,
            marker_visible: stickyResolved ? false : e.marker_visible,
            resolved_at: e.resolved_at || existing?.resolved_at,
            resolved_by: e.resolved_by || existing?.resolved_by,
            resolved_by_name: e.resolved_by_name || existing?.resolved_by_name,
            verified_at: e.verified_at || existing?.verified_at,
            verified_by: e.verified_by || existing?.verified_by,
            verified_by_name: e.verified_by_name || existing?.verified_by_name,
            status: stickyResolved
              ? (e.status === 'Cancelled' ? 'Cancelled' : 'Resolved')
              : (stickyVerified ? 'Verified' : (e.status || 'Received')),
          };

          newMap.set(sticky.id, sticky);
          if (sticky.callId && sticky.callId !== sticky.id) newMap.set(sticky.callId, sticky);
        });

        previousEmergenciesRef.current.forEach((oldVal, oldKey) => {
          if (!newMap.has(oldKey)) {
            newMap.set(oldKey, oldVal);
          }
        });
        previousEmergenciesRef.current = newMap;

        snapshot.docChanges().forEach((change) => {
          if (change.type === 'modified') {
            const data = change.doc.data();
            const docId = change.doc.id;

            if (data.status === 'Ended' && (data.ended_by === 'caller' || data.ended_by === 'user')) {
              if (activeIncomingCallIdRef.current === docId) {
                handleCallerEndedCall({
                  callId: docId,
                  userName: data.ended_by_name || data.caller_name || 'Caller',
                });
                return;
              }

              setMobileEmergencies(prev => prev.map(e =>
                e.id === docId ? {
                  ...e,
                  acknowledged: true,
                  status: 'Ended',
                  acknowledged_at: e.acknowledged_at || new Date().toISOString(),
                  acknowledged_by: e.acknowledged_by || 'caller',
                  acknowledged_by_name: e.acknowledged_by_name || `${data.ended_by_name || 'Caller'} (ended)`,
                } : e
              ));

              processedIdsRef.current.add(docId);
              const prevEntry = previousEmergenciesRef.current.get(docId);
              previousEmergenciesRef.current.set(docId, {
                ...(prevEntry || {
                  id: docId,
                  callId: data.callId || docId,
                  latitude: data.latitude || 0,
                  longitude: data.longitude || 0,
                  timestamp: data.timestamp || Date.now(),
                  source: data.source || 'mobile_app',
                  caller_name: getCallerName(data),
                } as MobileEmergencyCall),
                acknowledged: true,
                status: 'Ended',
              });
            }

            if (data.resolved === true || data.marker_visible === false) {
              resolvedEmergencyIdsRef.current.add(docId);
              if (data.callId) resolvedEmergencyIdsRef.current.add(data.callId);

              setMobileEmergencies(prev => prev.map(e => {
                if (e.id !== docId && e.callId !== docId) return e;
                return {
                  ...e,
                  incident_id: undefined,
                  resolved: true,
                  marker_visible: false,
                  resolved_at: data.resolved_at,
                  resolved_by: data.resolved_by,
                  resolved_by_name: data.resolved_by_name,
                  status: data.status === 'Cancelled' ? 'Cancelled' : 'Resolved',
                };
              }));

              const prevEntry = previousEmergenciesRef.current.get(docId);
              if (prevEntry) {
                previousEmergenciesRef.current.set(docId, {
                  ...prevEntry,
                  incident_id: undefined,
                  resolved: true,
                  marker_visible: false,
                  resolved_at: data.resolved_at,
                  status: data.status === 'Cancelled' ? 'Cancelled' : 'Resolved',
                });
              }
            }

            if (data.verified === true || data.status === 'Verified') {
              verifiedEmergencyIdsRef.current.add(docId);
              if (data.callId) verifiedEmergencyIdsRef.current.add(data.callId);
              if (data.incident_id) {
                verifiedIncidentMapRef.current.set(docId, data.incident_id);
                if (data.callId) verifiedIncidentMapRef.current.set(data.callId, data.incident_id);
              }
              setMobileEmergencies(prev => prev.map(e => e.id === docId ? {
                ...e,
                acknowledged: true,
                verified: true,
                verified_at: data.verified_at,
                verified_by: data.verified_by,
                verified_by_name: data.verified_by_name,
                incident_id: data.incident_id || e.incident_id,
                status: 'Verified',
              } : e));
            }

            if (data.acknowledged === true) {
              setMobileEmergencies(prev => prev.map(e => e.id === docId ? {
                ...e,
                caller_name: (e.caller_name && e.caller_name !== 'Citizen' && e.caller_name !== 'Unknown Caller')
                  ? e.caller_name : getCallerName(data, e.caller_name || 'Unknown Caller'),
                caller_phone: e.caller_phone || getCallerPhone(data, ''),
                acknowledged: true, acknowledged_at: data.acknowledged_at,
                acknowledged_by: data.acknowledged_by,
                acknowledged_by_name: data.acknowledged_by_name || data.dispatcher_name || data.dispatcherName,
                dispatcher_name: data.dispatcher_name || data.dispatcherName || data.acknowledged_by_name,
              } : e));

              const prev = previousEmergenciesRef.current.get(docId);
              if (prev) {
                const updated = { ...prev, acknowledged: true };
                previousEmergenciesRef.current.set(docId, updated);
                if (updated.callId && updated.callId !== docId) {
                  previousEmergenciesRef.current.set(updated.callId, updated);
                }
              }

              if (activeIncomingCallIdRef.current === docId) {
                const dispatcherName = data.acknowledged_by_name || data.dispatcher_name || data.dispatcherName || 'Dispatcher';
                stopRingtone();
                if (incomingCallTimeoutRef.current) { clearTimeout(incomingCallTimeoutRef.current); incomingCallTimeoutRef.current = null; }
                setShowIncomingCall(false);
                activeIncomingCallIdRef.current = null;
                window.setTimeout(() => setIncomingCall(null), 300);
                toast.success(`✅ ${dispatcherName} acknowledged emergency from ${data.caller_name || 'caller'}`);
              }
            }
          }
        });
      },
      (error) => { console.error('Error listening to emergency locations:', error); }
    );

    emergencyUnsubscribesRef.current.push(unsubscribeLocations);

    const callsQuery = query(
      collection(firestore, 'emergency_calls'),
      orderBy('timestamp', 'desc')
    );

    const unsubscribeCalls = onSnapshot(
      callsQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'modified') {
            const data = change.doc.data();
            const docId = change.doc.id;

            if (!data.acknowledged && !data.verified && data.resolved !== true) return;

            if (data.status === 'Ended' && (data.ended_by === 'caller' || data.ended_by === 'user')) {
              if (activeIncomingCallIdRef.current === docId) {
                handleCallerEndedCall({
                  callId: docId,
                  userName: data.ended_by_name || data.caller_name || 'Caller',
                });
                return;
              }

              setMobileEmergencies(prev => prev.map(e =>
                (e.callId === docId || e.id === docId) ? {
                  ...e,
                  acknowledged: true,
                  status: 'Ended',
                  acknowledged_at: e.acknowledged_at || new Date().toISOString(),
                  acknowledged_by: e.acknowledged_by || 'caller',
                  acknowledged_by_name: e.acknowledged_by_name || `${data.ended_by_name || 'Caller'} (ended)`,
                } : e
              ));

              processedIdsRef.current.add(docId);
              const prevEntry = previousEmergenciesRef.current.get(docId);
              previousEmergenciesRef.current.set(docId, {
                ...(prevEntry || {
                  id: docId,
                  callId: docId,
                  latitude: data.latitude || 0,
                  longitude: data.longitude || 0,
                  timestamp: data.timestamp || Date.now(),
                  source: 'mobile_app',
                  caller_name: getCallerName(data),
                } as MobileEmergencyCall),
                acknowledged: true,
                status: 'Ended',
              });
            }

            if (data.resolved === true || data.marker_visible === false) {
              resolvedEmergencyIdsRef.current.add(docId);
              if (data.callId) resolvedEmergencyIdsRef.current.add(data.callId);

              setMobileEmergencies(prev => prev.map(e =>
                (e.callId === docId || e.id === docId) ? {
                  ...e,
                  incident_id: undefined,
                  resolved: true,
                  marker_visible: false,
                  resolved_at: data.resolved_at,
                  resolved_by: data.resolved_by,
                  resolved_by_name: data.resolved_by_name,
                  status: data.status === 'Cancelled' ? 'Cancelled' : 'Resolved',
                } : e
              ));

              [docId, data.callId].filter(Boolean).forEach(key => {
                const prev = previousEmergenciesRef.current.get(key);
                if (prev) {
                  previousEmergenciesRef.current.set(key, {
                    ...prev,
                    incident_id: undefined,
                    resolved: true,
                    marker_visible: false,
                    resolved_at: data.resolved_at,
                    status: data.status === 'Cancelled' ? 'Cancelled' : 'Resolved',
                  });
                }
              });
            }

            if (data.verified === true || data.status === 'Verified') {
              verifiedEmergencyIdsRef.current.add(docId);
              if (data.callId) verifiedEmergencyIdsRef.current.add(data.callId);
              if (data.incident_id) {
                verifiedIncidentMapRef.current.set(docId, data.incident_id);
                if (data.callId) verifiedIncidentMapRef.current.set(data.callId, data.incident_id);
              }

              setMobileEmergencies(prev => prev.map(e =>
                (e.callId === docId || e.id === docId) ? {
                  ...e,
                  acknowledged: true,
                  verified: true,
                  verified_at: data.verified_at,
                  verified_by: data.verified_by,
                  verified_by_name: data.verified_by_name,
                  incident_id: data.incident_id || e.incident_id,
                  status: 'Verified',
                } : e
              ));

              [docId, data.callId].filter(Boolean).forEach(key => {
                const prev = previousEmergenciesRef.current.get(key);
                if (prev) {
                  previousEmergenciesRef.current.set(key, {
                    ...prev,
                    acknowledged: true,
                    verified: true,
                    verified_at: data.verified_at,
                    verified_by: data.verified_by,
                    verified_by_name: data.verified_by_name,
                    incident_id: data.incident_id || prev.incident_id,
                    status: 'Verified',
                  });
                }
              });
            }

            if (data.acknowledged === true) {
              setMobileEmergencies(prev => prev.map(e =>
                e.callId === docId || e.id === docId ? {
                  ...e,
                  caller_name: (e.caller_name && e.caller_name !== 'Citizen' && e.caller_name !== 'Unknown Caller')
                    ? e.caller_name : getCallerName(data, e.caller_name || 'Unknown Caller'),
                  caller_phone: e.caller_phone || getCallerPhone(data, ''),
                  acknowledged: true, acknowledged_at: data.acknowledged_at,
                  acknowledged_by: data.acknowledged_by,
                  acknowledged_by_name: data.acknowledged_by_name || data.dispatcher_name || data.dispatcherName,
                  dispatcher_name: data.dispatcher_name || data.dispatcherName || data.acknowledged_by_name,
                } : e));

              if (activeIncomingCallIdRef.current === docId) {
                const dispatcherName = data.acknowledged_by_name || data.dispatcher_name || data.dispatcherName || 'Dispatcher';
                stopRingtone();
                if (incomingCallTimeoutRef.current) { clearTimeout(incomingCallTimeoutRef.current); incomingCallTimeoutRef.current = null; }
                setShowIncomingCall(false);
                activeIncomingCallIdRef.current = null;
                window.setTimeout(() => setIncomingCall(null), 300);
                toast.success(`✅ ${dispatcherName} acknowledged emergency from ${data.caller_name || 'caller'}`);
              }
            }
          }
        });
      },
      (error) => { console.error('Error listening to emergency calls:', error); }
    );

    emergencyUnsubscribesRef.current.push(unsubscribeCalls);

    return () => {
      emergencyUnsubscribesRef.current.forEach(unsub => { try { unsub(); } catch (e) { /* ignore */ } });
      emergencyUnsubscribesRef.current = [];
    };
  }, [stopRingtone, cleanupWebRTC, handleCallerEndedCall]);

  // ============================================================
  // SUBSCRIPTION 1 — INCIDENTS (mount once)
  // ============================================================
  useEffect(() => {
    const unsubIncidents = subscribeToIncidents((data: Incident[]) => {
      const normalized = data.map(inc => {
        const originalStatus = inc.status;
        let normalizedStatus = normalizeIncidentStatus(inc.status);

        if (
          normalizedStatus !== 'Resolved' &&
          normalizedStatus !== 'Cancelled' &&
          resolvedIncidentIdsRef.current.has(inc.incident_id)
        ) {
          normalizedStatus = 'Resolved';
        }

        if (!incidentsDebugDumpedRef.current) {
          console.log(
            `📋 [IncidentDocDebug] docId="${(inc as any).id || '(none)'}" ` +
            `incident_id="${inc.incident_id}" status="${originalStatus}"`
          );
        }

        return {
          ...inc,
          status: normalizedStatus as any,
        };
      });

      if (!incidentsDebugDumpedRef.current && normalized.length > 0) {
        incidentsDebugDumpedRef.current = true;
      }

      setIncidents(normalized);
    });

    return () => unsubIncidents();
  }, []);

  // ============================================================
  // SUBSCRIPTION 2 — UNITS (mount once)
  // ============================================================
  useEffect(() => {
    const unsubUnits = subscribeToUnits((data: ResponseUnit[]) => {
      setUnitsLoaded(true);

      if (data.length === 0) {
        setUnits(prev => (prev.length === 0 ? DEFAULT_UNITS_FALLBACK : prev));
        return;
      }

      const existingIds = new Set(data.map(u => u.unit_id));
      const missing = DEFAULT_UNITS_FALLBACK.filter(d => !existingIds.has(d.unit_id));

      const normalized = data.map(u => {
        const hasActiveIncident = !!u.current_incident_id;
        const isBusyStatus = (BUSY_UNIT_STATUSES as readonly string[]).includes(u.status);

        if (isBusyStatus && !hasActiveIncident) {
          return { ...u, status: 'Available' as ResponseUnit['status'], current_incident_id: null };
        }

        return u;
      });

      setUnits(prev => {
        const prevMap = new Map(prev.map(u => [u.unit_id, u]));
        const merged: ResponseUnit[] = normalized.map(n => {
          const existing = prevMap.get(n.unit_id);
          if (existing && hasValidCoords(existing)) {
            return {
              ...n,
              latitude: existing.latitude,
              longitude: existing.longitude,
              last_active: (existing as any).last_active ?? (n as any).last_active,
              last_update: existing.last_update ?? n.last_update,
              is_online: (n as any).is_online ?? (existing as any).is_online,
            } as ResponseUnit;
          }
          return n;
        });

        missing.forEach(m => {
          if (!merged.some(x => x.unit_id === m.unit_id)) {
            merged.push(m);
          }
        });

        return merged;
      });
    });

    return () => unsubUnits();
  }, []);

  // ============================================================
  // SUBSCRIPTION 3 — SENSORS (mount once)
  // ============================================================
  useEffect(() => {
    const unsubSensors = subscribeToSensors((data: SensorWithThreat[]) => {
      const now = Date.now();
      const last = lastSnapshotAtRef.current.get('sensors') || 0;
      if (last > 0) {
        const delta = now - last;
        if (delta > 0 && delta < 30_000) {
          snapshotLatencyRef.current.push(delta);
          if (snapshotLatencyRef.current.length > LATENCY_WINDOW) {
            snapshotLatencyRef.current.shift();
          }
          const avg =
            snapshotLatencyRef.current.reduce((a, b) => a + b, 0) /
            snapshotLatencyRef.current.length;
          setLiveLatencyMs(Math.round(avg));
        }
      }
      lastSnapshotAtRef.current.set('sensors', now);

      const sensorData = (data || []).map(s => {
        const stickyAck = sensorAckRef.current.has(s.sensor_id);
        const stickyIncidentId = sensorVerifiedRef.current.get(s.sensor_id);

        return {
          ...s,
          dispatcher_acknowledged: stickyAck || (s as any).dispatcher_acknowledged === true,
          verified: !!stickyIncidentId || (s as any).verified === true,
          incident_id: stickyIncidentId || (s as any).incident_id,
        } as SensorWithThreat;
      });

      setSensors(sensorData);

      // ⭐ LIVE sensors — needed for audio gating
      const liveRedSensors = sensorData.filter(
        s =>
          isSensorLive(s) &&
          s.threat_level === 'RED'
      );

      const liveYellowSensors = sensorData.filter(
        s =>
          isSensorLive(s) &&
          s.threat_level === 'YELLOW'
      );

      const unackedRed = liveRedSensors.find(
        s => !s.dispatcher_acknowledged && !s.verified
      );

      const unackedYellow = liveYellowSensors.find(
        s => !s.dispatcher_acknowledged && !s.verified
      );

      // ⭐ Fall back to sticky snapshot if sensor went stale
      const stickyYellow = stickyYellowAlertRef.current
        ? sensorData.find(
            s =>
              s.sensor_id === stickyYellowAlertRef.current!.sensor_id &&
              (s.threat_level === 'YELLOW' || stickySensorDataRef.get(s.sensor_id)?.threat_level === 'YELLOW') &&
              !s.verified &&
              !s.dispatcher_acknowledged &&
              isSensorVisibleOnDispatcherMap(s)
          )
        : undefined;

      const stickyRed = stickyRedAlertRef.current
        ? sensorData.find(
            s =>
              s.sensor_id === stickyRedAlertRef.current!.sensor_id &&
              (s.threat_level === 'RED' || stickySensorDataRef.get(s.sensor_id)?.threat_level === 'RED') &&
              !s.verified &&
              !s.dispatcher_acknowledged &&
              isSensorVisibleOnDispatcherMap(s)
          )
        : undefined;

      const effectiveRed = unackedRed || stickyRed;
      const effectiveYellow = unackedYellow || stickyYellow;

      // ⭐ RED threat alert — sticky overlay
      if (
        effectiveRed &&
        (!iotHighThreatAlarmRef.current ||
          highThreatSensorRef.current?.sensor_id !== effectiveRed.sensor_id)
      ) {
        const merged = mergeWithStickySnapshot(effectiveRed);
        stickyRedAlertRef.current = merged;
        setIotHighThreatAlarm(true);
        setHighThreatSensor(merged);
        setMapCenter({
          lat: merged.latitude,
          lng: merged.longitude,
          address: merged.location_name || merged.location,
          name: merged.sensor_id,
        });
        if (mapRef.current && isSensorLive(effectiveRed)) {
          mapRef.current.panTo({ lat: merged.latitude, lng: merged.longitude });
          mapRef.current.setZoom(17);
        }
        // Audio ONLY if truly live
        if (isSensorLive(effectiveRed) && iotAlarmAudioRef.current) {
          iotAlarmAudioRef.current.play().catch(() => { });
        }
      }

      // Clear RED overlay ONLY when there's no sticky visible pin left
      if (!effectiveRed && iotHighThreatAlarmRef.current) {
        stickyRedAlertRef.current = null;
        setIotHighThreatAlarm(false);
        setHighThreatSensor(null);
        if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
      }

      // ⭐ Sticky overlay but sensor went stale → silence audio, keep overlay
      if (
        effectiveRed &&
        !isSensorLive(effectiveRed) &&
        iotAlarmAudioRef.current
      ) {
        iotAlarmAudioRef.current.pause();
      }

      // ⭐ YELLOW threat alert — STICKY overlay
      if (
        effectiveYellow &&
        (!gasSmokeAlarmRef.current ||
          gasSmokeSensorRef.current?.sensor_id !== effectiveYellow.sensor_id)
      ) {
        const merged = mergeWithStickySnapshot(effectiveYellow);
        stickyYellowAlertRef.current = merged;
        setGasSmokeAlarm(true);
        setGasSmokeSensor(merged);
        if (isSensorLive(effectiveYellow) && yellowAlarmAudioRef.current) {
          yellowAlarmAudioRef.current.play().catch(() => { });
        }
        if (
          !iotHighThreatAlarm &&
          mapRef.current &&
          isSensorLive(effectiveYellow)
        ) {
          mapRef.current.panTo({
            lat: merged.latitude,
            lng: merged.longitude,
          });
          mapRef.current.setZoom(17);
        }
      }

      // Clear YELLOW overlay ONLY when there's no sticky visible pin left
      if (!effectiveYellow && gasSmokeAlarmRef.current) {
        stickyYellowAlertRef.current = null;
        setGasSmokeAlarm(false);
        setGasSmokeSensor(null);
        if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
      }

      // ⭐ Sticky overlay but sensor went stale → silence audio, keep overlay
      if (
        effectiveYellow &&
        !isSensorLive(effectiveYellow) &&
        yellowAlarmAudioRef.current
      ) {
        yellowAlarmAudioRef.current.pause();
      }
    });

    return () => unsubSensors();
  }, []);

  // ============================================================
  // SUBSCRIPTION 4 — UNIT DISPATCHES (mount once)
  // ============================================================
  useEffect(() => {
    const unsubDispatches = onSnapshot(
      query(
        collection(firestore, 'unit_dispatches'),
        orderBy('dispatched_at', 'desc'),
        limit(60)
      ),
      (snap) => {
        const next = new Map<string, LatestDispatchInfo>();

        snap.docs.forEach((docSnap) => {
          const d = docSnap.data() as any;
          const unitId = d.target_unit_id;
          if (!unitId) return;

          const dispatchedAtMs =
            d.dispatched_at?.toDate?.().getTime?.() ??
            (typeof d.dispatched_at === 'number' ? d.dispatched_at : 0);

          const prev = next.get(unitId);
          if (prev && dispatchedAtMs < prev.dispatchedAtMs) return;

          const info: LatestDispatchInfo = {
            docId: docSnap.id,
            incidentId: d.incident_id || null,
            status: d.status || 'pending',
            acknowledged: d.acknowledged === true,
            navigationStarted: d.navigation_started === true,
            navigationStopped: d.navigation_stopped === true,
            cancelled: d.cancelled === true,
            completed: d.completed === true,
            resolved: d.resolved === true,
            resolvedAt: d.resolved_at,
            resolvedByUnit: d.resolved_by_unit || '',
            dispatchedAtMs,
            isTerminal: isTerminalDispatch(d),
            derivedStatus: deriveDispatchStatus(d),
          };
          next.set(unitId, info);
        });

        setLatestDispatchByUnit(next);
      },
      (err) => console.warn('unit_dispatches listener error:', err)
    );

    return () => unsubDispatches();
  }, []);

  // ============================================================
  // ⭐ REAL-TIME: track incident→sensor links
  // ============================================================
  useEffect(() => {
    console.log('✅ [SensorLink] Watching incident↔sensor links (real-time)');

    const q = query(
      collection(firestore, 'incidents'),
      orderBy('reported_at', 'desc'),
      limit(200)
    );

    const unsub = onSnapshot(q, (snap) => {
      const nextLinks = new Map<string, string>();
      const resolvedSensorIds = new Set<string>();

      snap.docs.forEach((docSnap) => {
        const d = docSnap.data() as any;
        const incidentId = d.incident_id || docSnap.id;
        const sensorId = d.sensor_id;
        if (!sensorId) return;

        const status = normalizeIncidentStatus(d.status);
        const isResolved = status === 'Resolved' || status === 'Cancelled';

        if (isResolved) {
          resolvedSensorIds.add(sensorId);
        } else {
          nextLinks.set(incidentId, sensorId);
        }
      });

      sensorLinkByIncidentRef.current = nextLinks;

      resolvedSensorIds.forEach(sensorId => {
        if (sensorVerifiedRef.current.has(sensorId) || stickySensorPinIdsRef.has(sensorId)) {
          console.log(
            `🔵➜⚫ [SensorLink] Incident resolved → clearing blue pin + sticky flag for sensor ${sensorId}`
          );
          sensorVerifiedRef.current.delete(sensorId);
          sensorAckRef.current.delete(sensorId);
          clearStickySensor(sensorId);

          setSensors(prev => prev.map(s =>
            s.sensor_id === sensorId
              ? {
                ...s,
                verified: false,
                verified_at: undefined,
                verified_by_name: undefined,
                incident_id: undefined,
                dispatcher_acknowledged: false,
              }
              : s
          ));

          if (highThreatSensorRef.current?.sensor_id === sensorId) {
            stickyRedAlertRef.current = null;
            setIotHighThreatAlarm(false);
            setHighThreatSensor(null);
            if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
          }
          if (gasSmokeSensorRef.current?.sensor_id === sensorId) {
            stickyYellowAlertRef.current = null;
            setGasSmokeAlarm(false);
            setGasSmokeSensor(null);
            if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
          }
        }
      });

      setSensors(prev => {
        let changed = false;
        const next = prev.map(s => {
          if (!s.verified && !s.incident_id) return s;

          const linkedIncident = s.incident_id;
          const stillLinked =
            linkedIncident && nextLinks.get(linkedIncident) === s.sensor_id;

          if (stillLinked) return s;

          if (s.verified || s.incident_id) {
            changed = true;
            clearStickySensor(s.sensor_id);
            return {
              ...s,
              verified: false,
              verified_at: undefined,
              verified_by_name: undefined,
              incident_id: undefined,
            };
          }
          return s;
        });
        return changed ? next : prev;
      });
    }, (err) => {
      console.warn('❌ [SensorLink] listener error:', err);
    });

    return () => unsub();
  }, []);

  // ============================================================
  // ⭐ SENSOR HEARTBEAT WATCHDOG (v30)
  // ============================================================
  useEffect(() => {
    const id = window.setInterval(() => {
      setHighThreatSensor(prevHigh => {
        if (!prevHigh) return prevHigh;

        const stillVisible =
          !prevHigh.verified &&
          !prevHigh.dispatcher_acknowledged &&
          isSensorVisibleOnDispatcherMap(prevHigh);

        if (!stillVisible) {
          console.log(
            `🔇 [SensorWatchdog] ${prevHigh.sensor_id} no longer visible — clearing FIRE alert`
          );
          stickyRedAlertRef.current = null;
          setIotHighThreatAlarm(false);
          if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
          return null;
        }

        const liveDoc = sensorsRefForWatchdog.current.find(s => s.sensor_id === prevHigh.sensor_id);
        if (liveDoc && !isSensorLive(liveDoc)) {
          console.log(
            `🔇 [SensorWatchdog] ${prevHigh.sensor_id} stale — silencing RED audio (overlay + pin stay)`
          );
          if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
        }
        return prevHigh;
      });

      setGasSmokeSensor(prevGas => {
        if (!prevGas) return prevGas;

        const stillVisible =
          !prevGas.verified &&
          !prevGas.dispatcher_acknowledged &&
          isSensorVisibleOnDispatcherMap(prevGas);

        if (!stillVisible) {
          console.log(
            `🔇 [SensorWatchdog] ${prevGas.sensor_id} no longer visible — clearing gas/smoke alert`
          );
          stickyYellowAlertRef.current = null;
          setGasSmokeAlarm(false);
          if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
          return null;
        }

        const liveDoc = sensorsRefForWatchdog.current.find(s => s.sensor_id === prevGas.sensor_id);
        if (liveDoc && !isSensorLive(liveDoc)) {
          console.log(
            `🔇 [SensorWatchdog] ${prevGas.sensor_id} stale — silencing YELLOW audio (overlay + pin stay)`
          );
          if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
        }
        return prevGas;
      });
    }, 15_000);

    return () => clearInterval(id);
  }, []);

  // ============================================================
  // ⭐ RED SENSOR PULSE/FLASH (v30)
  // ============================================================
  useEffect(() => {
    const prev = sensorRedStateRef.current;
    const flashes: SensorFlash[] = [];
    const now = Date.now();

    for (const s of sensors) {
      const wasRed = prev.get(s.sensor_id) === true;

      // ⭐ Consider a sensor "red" if it's still visible as a red pin,
      //    which includes sticky snapshot pins whose live threat_level
      //    may have been reset to NORMAL.
      const cached = stickySensorDataRef.get(s.sensor_id);
      const effectiveThreat = cached && stickySensorPinIdsRef.has(s.sensor_id)
        ? cached.threat_level
        : s.threat_level;

      const isRed =
        effectiveThreat === 'RED' &&
        !s.verified &&
        isSensorVisibleOnDispatcherMap(s);

      if (!wasRed && isRed) {
        flashes.push({ sensorId: s.sensor_id, startedAt: now });
        console.log(
          `⚡ [RealTime] Sensor ${s.sensor_id} transitioned INTO RED — flashing (sticky)`
        );

        if (!highThreatSensor || highThreatSensor.sensor_id !== s.sensor_id) {
          if (!sensorAlarmReTriggerIdsRef.current.has(s.sensor_id)) {
            sensorAlarmReTriggerIdsRef.current.add(s.sensor_id);

            const merged = mergeWithStickySnapshot(s);
            stickyRedAlertRef.current = merged;
            setIotHighThreatAlarm(true);
            setHighThreatSensor(merged);
            setMapCenter({
              lat: merged.latitude,
              lng: merged.longitude,
              address: merged.location_name || merged.location,
              name: merged.sensor_id,
            });
            if (mapRef.current && hasValidCoords(merged) && isSensorLive(s)) {
              mapRef.current.panTo({ lat: merged.latitude, lng: merged.longitude });
              mapRef.current.setZoom(17);
            }
            if (isSensorLive(s) && iotAlarmAudioRef.current) {
              iotAlarmAudioRef.current.play().catch(() => { });
            }
          }
        }
      }

      if (wasRed && !isRed) {
        sensorAlarmReTriggerIdsRef.current.delete(s.sensor_id);
      }

      prev.set(s.sensor_id, isRed);
    }

    if (flashes.length > 0) {
      setSensorFlashes(prevFlashes => {
        const stillActive = prevFlashes.filter(
          f => sensorRedStateRef.current.get(f.sensorId) === true
        );
        return [...stillActive, ...flashes];
      });
    } else {
      setSensorFlashes(prevFlashes => {
        const stillActive = prevFlashes.filter(
          f => sensorRedStateRef.current.get(f.sensorId) === true
        );
        return stillActive.length === prevFlashes.length
          ? prevFlashes
          : stillActive;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensors]);

  const iotHighThreatAlarmRef = useRef<boolean>(false);
  const highThreatSensorRef = useRef<SensorWithThreat | null>(null);
  const gasSmokeAlarmRef = useRef<boolean>(false);
  const gasSmokeSensorRef = useRef<SensorWithThreat | null>(null);
  const sensorFlashesRef = useRef<SensorFlash[]>([]);

  useEffect(() => {
    iotHighThreatAlarmRef.current = iotHighThreatAlarm;
  }, [iotHighThreatAlarm]);

  useEffect(() => {
    highThreatSensorRef.current = highThreatSensor;
  }, [highThreatSensor]);

  useEffect(() => {
    gasSmokeAlarmRef.current = gasSmokeAlarm;
  }, [gasSmokeAlarm]);

  useEffect(() => {
    gasSmokeSensorRef.current = gasSmokeSensor;
  }, [gasSmokeSensor]);

  useEffect(() => {
    sensorFlashesRef.current = sensorFlashes;
  }, [sensorFlashes]);

  const sensorYellowStateRef = useRef<Map<string, boolean>>(new Map());

  // ============================================================
  // ⭐ YELLOW SENSOR DETECTION (v30) — STICKY OVERLAY
  // ============================================================
  useEffect(() => {
    const prev = sensorYellowStateRef.current;

    for (const s of sensors) {
      const wasYellow = prev.get(s.sensor_id) === true;
      const cached = stickySensorDataRef.get(s.sensor_id);
      const effectiveThreat = cached && stickySensorPinIdsRef.has(s.sensor_id)
        ? cached.threat_level
        : s.threat_level;

      const isYellow =
        effectiveThreat === 'YELLOW' &&
        !s.verified &&
        !s.dispatcher_acknowledged &&
        isSensorVisibleOnDispatcherMap(s);

      if (!wasYellow && isYellow) {
        console.log(
          `⚠️ [RealTime] Sensor ${s.sensor_id} transitioned INTO YELLOW (gas/smoke) — sticky pin + alert`
        );

        const merged = mergeWithStickySnapshot(s);
        stickyYellowAlertRef.current = merged;
        setGasSmokeAlarm(true);
        setGasSmokeSensor(merged);

        if (
          !iotHighThreatAlarm &&
          mapRef.current &&
          hasValidCoords(merged) &&
          isSensorLive(s)
        ) {
          mapRef.current.panTo({ lat: merged.latitude, lng: merged.longitude });
          mapRef.current.setZoom(17);
        }
        // Audio ONLY if truly live
        if (isSensorLive(s) && yellowAlarmAudioRef.current) {
          yellowAlarmAudioRef.current.play().catch(() => { });
        }
      }

      if (wasYellow && !isYellow) {
        console.log(`✅ [RealTime] Sensor ${s.sensor_id} cleared from YELLOW — pin gone`);
        if (stickyYellowAlertRef.current?.sensor_id === s.sensor_id) {
          stickyYellowAlertRef.current = null;
        }
        if (gasSmokeSensorRef.current?.sensor_id === s.sensor_id) {
          setGasSmokeAlarm(false);
          setGasSmokeSensor(null);
          if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
        }
      }

      // ⭐ Pin still visible but sensor went stale → silence audio only
      if (isYellow && !isSensorLive(s) && yellowAlarmAudioRef.current) {
        yellowAlarmAudioRef.current.pause();
      }

      prev.set(s.sensor_id, isYellow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensors]);

  // ============================================================
  // ⭐ FLASH PRUNING (v30) — prune by PIN VISIBILITY, not time
  // ============================================================
  useEffect(() => {
    if (sensorFlashes.length === 0) return;
    const interval = window.setInterval(() => {
      setSensorFlashes(prev =>
        prev.filter(f => sensorRedStateRef.current.get(f.sensorId) === true)
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [sensorFlashes.length]);

  // ============================================================
  // IMPERATIVE SENSOR MARKERS (sticky)
  // ============================================================
  useEffect(() => {
    const gmaps = window.google?.maps;
    const map = mapRef.current;
    if (!gmaps || !map || !mapLoaded) return;

    const markers = imperativeSensorMarkersRef.current;
    const targets = imperativeSensorTargetPosRef.current;

    // ⭐ Merge sticky snapshots so pins whose live doc went stale
    //    still render with correct position/threat.
    const activeMapSensors = sensors
      .map(s => mergeWithStickySnapshot(s))
      .filter(
        (s) =>
          hasValidCoords(s) &&
          isSensorVisibleOnDispatcherMap(s)
      );

    const activeIds = new Set(activeMapSensors.map((s) => s.sensor_id));

    markers.forEach((marker, sensorId) => {
      if (!activeIds.has(sensorId)) {
        try { marker.setMap(null); } catch { /* ignore */ }
        markers.delete(sensorId);
        targets.delete(sensorId);
      }
    });

    activeMapSensors.forEach((sensor) => {
      const target = { lat: sensor.latitude, lng: sensor.longitude };
      targets.set(sensor.sensor_id, target);

      const flashing = sensorFlashesRef.current.some(
        (f) => f.sensorId === sensor.sensor_id
      );

      const isVerified = !!sensor.verified || !!sensor.incident_id;

      let marker = markers.get(sensor.sensor_id);
      if (!marker) {
        marker = new gmaps.Marker({
          position: target,
          map,
          icon: getSensorIcon(
            sensor.threat_level || undefined,
            isVerified,
            flashing
          ),
          title: sensor.location_name || sensor.sensor_id,
          zIndex: isVerified ? 950 : sensor.threat_level === 'RED' ? 1000 : 900,
        });

        marker.addListener('click', () => {
          const live = sensorsRefForWatchdog.current.find(
            (x) => x.sensor_id === sensor.sensor_id
          );
          const merged = live ? mergeWithStickySnapshot(live) : sensor;
          if (merged) {
            setSelectedMarker({ type: 'sensor', data: merged });
            setSelectedSensor(merged);
            setShowSensorModal(true);
          }
        });

        markers.set(sensor.sensor_id, marker);
      } else {
        marker.setIcon(
          getSensorIcon(
            sensor.threat_level || undefined,
            isVerified,
            flashing
          )
        );
        marker.setTitle(sensor.location_name || sensor.sensor_id);
        marker.setZIndex(
          isVerified ? 950 : sensor.threat_level === 'RED' ? 1000 : 900
        );
      }
    });

    const step = () => {
      let stillAnimating = false;

      markers.forEach((marker, sensorId) => {
        const target = targets.get(sensorId);
        if (!target) return;

        const current = marker.getPosition();
        if (!current) {
          marker.setPosition(target);
          return;
        }

        const dLat = target.lat - current.lat();
        const dLng = target.lng - current.lng();
        const distance = Math.sqrt(dLat * dLat + dLng * dLng);

        if (distance < 0.000001) {
          marker.setPosition(target);
          return;
        }

        stillAnimating = true;
        const factor = distance > 0.001 ? 0.12 : 0.18;
        marker.setPosition({
          lat: current.lat() + dLat * factor,
          lng: current.lng() + dLng * factor,
        });
      });

      if (stillAnimating) {
        imperativeSensorAnimFrameRef.current = requestAnimationFrame(step);
      } else {
        imperativeSensorAnimFrameRef.current = null;
      }
    };

    if (imperativeSensorAnimFrameRef.current === null) {
      imperativeSensorAnimFrameRef.current = requestAnimationFrame(step);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensors, mapLoaded]);

  useEffect(() => {
    return () => {
      imperativeSensorMarkersRef.current.forEach(marker => {
        try { marker.setMap(null); } catch { /* ignore */ }
      });
      imperativeSensorMarkersRef.current.clear();
      imperativeSensorTargetPosRef.current.clear();
      if (imperativeSensorAnimFrameRef.current !== null) {
        cancelAnimationFrame(imperativeSensorAnimFrameRef.current);
        imperativeSensorAnimFrameRef.current = null;
      }
    };
  }, []);

  // ============================================================
  // ⭐ RESOLVE SYNC — clears sensor + sticky flag
  // ============================================================
  useEffect(() => {
    console.log('✅ [ResolveSync] Bridge listening on unit_dispatches for resolutions');

    const q = query(
      collection(firestore, 'unit_dispatches'),
      orderBy('dispatched_at', 'desc'),
      limit(80)
    );

    const unsub = onSnapshot(q, (snap) => {
      const changes = snap.docChanges();

      const docsToProcess: Array<{ id: string; data: any }> =
        changes.length > 0
          ? changes
            .filter((c) => c.type === 'modified' || c.type === 'added')
            .map((c) => ({ id: c.doc.id, data: c.doc.data() as any }))
          : snap.docs.map((d) => ({ id: d.id, data: d.data() as any }));

      docsToProcess.forEach(({ id: docId, data: d }) => {
        const dispatchStatus = (d.status || '').toLowerCase();
        const isResolved =
          dispatchStatus === 'resolved' ||
          d.resolved === true ||
          (d.resolved_at != null &&
            dispatchStatus !== 'cancelled' &&
            dispatchStatus !== 'canceled' &&
            d.cancelled !== true);

        if (!isResolved) return;

        const incidentId = d.incident_id;
        if (!incidentId) return;

        const key = `${docId}::${incidentId}`;
        if (resolveSyncedDispatchIdsRef.current.has(key)) return;
        resolveSyncedDispatchIdsRef.current.add(key);

        const resolvedAtIso = coerceTimestampToIso(d.resolved_at);
        const resolvedByUnit =
          d.resolved_by_unit ||
          d.target_unit_name ||
          d.target_unit_code ||
          d.target_unit_id ||
          '';

        console.log(
          `✅ [ResolveSync] Dispatch "${docId}" resolved → propagating to incident "${incidentId}" ` +
          `(unit: ${resolvedByUnit || 'n/a'}, at: ${resolvedAtIso})`
        );

        resolvedIncidentIdsRef.current.add(incidentId);

        setIncidents((prev) => {
          let changed = false;
          const next = prev.map((inc) => {
            const isMatch =
              inc.incident_id === incidentId ||
              (inc as any).id === incidentId;
            if (!isMatch) return inc;
            if (normalizeIncidentStatus(inc.status) === 'Resolved') return inc;
            changed = true;
            return {
              ...inc,
              status: 'Resolved' as any,
              resolved_at: resolvedAtIso,
              resolved_by_unit: resolvedByUnit,
            } as Incident & { resolved_at?: string; resolved_by_unit?: string };
          });
          return changed ? next : prev;
        });

        (async () => {
          try {
            const incidentsRef = collection(firestore, 'incidents');

            const qField = query(incidentsRef, where('incident_id', '==', incidentId));
            const byField = await getDocs(qField);

            const matched = byField.docs;

            if (matched.length === 0) {
              console.warn(
                `⚠️ [ResolveSync] No incident doc matched incident_id="${incidentId}" — skipping Firestore incident update`
              );
            } else {
              for (const docSnap of matched) {
                const cur = docSnap.data() as any;
                if (normalizeIncidentStatus(cur.status) === 'Resolved') {
                  continue;
                }
                await updateDoc(doc(firestore, 'incidents', docSnap.id), {
                  status: 'Resolved',
                  resolved_at: d.resolved_at || serverTimestamp(),
                  resolved_by_unit: resolvedByUnit,
                  updated_at: serverTimestamp(),
                });
                console.log(
                  `✅ [ResolveSync] Firestore incident "${docSnap.id}" (incident_id=${incidentId}) → Resolved`
                );
              }
            }
          } catch (err) {
            console.warn('❌ [ResolveSync] Firestore incident propagation failed:', err);
          }

          try {
            await mirrorResolutionToSafeReport({
              incidentId,
              resolvedAtIso,
              resolvedByUnit,
              dispatchDoc: d,
            });
          } catch (err) {
            console.warn('❌ [ResolveSync] Safe-report mirror failed:', err);
          }

          try {
            const incidentsRef = collection(firestore, 'incidents');
            const qSensor = query(
              incidentsRef,
              where('incident_id', '==', incidentId),
              limit(1)
            );
            const sensorIncSnap = await getDocs(qSensor);

            if (!sensorIncSnap.empty) {
              const incData = sensorIncSnap.docs[0].data() as any;
              const sensorId = incData?.sensor_id;

              if (sensorId) {
                console.log(
                  `🧹 [ResolveSync] Clearing sensor ${sensorId} (incident ${incidentId} resolved)`
                );

                await updateDoc(doc(firestore, 'iot_sensors', sensorId), {
                  verified: false,
                  verified_at: null,
                  verified_by: null,
                  verified_by_name: null,
                  incident_id: null,
                  dispatcher_acknowledged: false,
                  dispatcher_acknowledged_at: null,
                  dispatcher_acknowledged_by: null,
                  dispatcher_acknowledged_by_name: null,
                  updated_at: serverTimestamp(),
                });

                sensorVerifiedRef.current.delete(sensorId);
                sensorAckRef.current.delete(sensorId);
                clearStickySensor(sensorId);

                setSensors(prev => prev.map(s =>
                  s.sensor_id === sensorId
                    ? {
                      ...s,
                      verified: false,
                      verified_at: undefined,
                      verified_by_name: undefined,
                      incident_id: undefined,
                      dispatcher_acknowledged: false,
                    }
                    : s
                ));

                if (highThreatSensorRef.current?.sensor_id === sensorId) {
                  stickyRedAlertRef.current = null;
                  setIotHighThreatAlarm(false);
                  setHighThreatSensor(null);
                  if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
                }
                if (gasSmokeSensorRef.current?.sensor_id === sensorId) {
                  stickyYellowAlertRef.current = null;
                  setGasSmokeAlarm(false);
                  setGasSmokeSensor(null);
                  if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
                }
              }
            }
          } catch (err) {
            console.warn('❌ [ResolveSync] Sensor reset failed:', err);
          }
        })();
      });
    }, (err) => {
      console.warn('❌ [ResolveSync] listener error:', err);
    });

    return () => unsub();
  }, []);

  // ============================================================
  // ⭐ SENSOR ↔ INCIDENT RESOLUTION BRIDGE — clears sticky flag
  // ============================================================
  const sensorResetIncidentIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    console.log('✅ [SensorResetSync] Watching for resolved incidents tied to sensors');

    const unsub = onSnapshot(
      query(
        collection(firestore, 'incidents'),
        orderBy('reported_at', 'desc'),
        limit(120)
      ),
      (snap) => {
        snap.docs.forEach((docSnap) => {
          const d = docSnap.data() as any;
          const incidentId = d.incident_id || docSnap.id;
          const sensorId = d.sensor_id;

          if (!sensorId) return;

          const status = normalizeIncidentStatus(d.status);
          const isResolved = status === 'Resolved' || status === 'Cancelled';
          if (!isResolved) return;

          const key = `${incidentId}::${sensorId}`;
          if (sensorResetIncidentIdsRef.current.has(key)) return;
          sensorResetIncidentIdsRef.current.add(key);

          console.log(
            `🧹 [SensorResetSync] Incident ${incidentId} resolved — ` +
            `clearing dispatcher state on sensor ${sensorId}`
          );

          (async () => {
            try {
              await updateDoc(doc(firestore, 'iot_sensors', sensorId), {
                verified: false,
                verified_at: null,
                verified_by: null,
                verified_by_name: null,
                incident_id: null,
                dispatcher_acknowledged: false,
                dispatcher_acknowledged_at: null,
                dispatcher_acknowledged_by: null,
                dispatcher_acknowledged_by_name: null,
                updated_at: serverTimestamp(),
              });

              sensorVerifiedRef.current.delete(sensorId);
              sensorAckRef.current.delete(sensorId);
              clearStickySensor(sensorId);

              setSensors(prev => prev.map(s =>
                s.sensor_id === sensorId
                  ? {
                    ...s,
                    verified: false,
                    verified_at: undefined,
                    verified_by_name: undefined,
                    incident_id: undefined,
                    dispatcher_acknowledged: false,
                  }
                  : s
              ));

              if (highThreatSensorRef.current?.sensor_id === sensorId) {
                stickyRedAlertRef.current = null;
                setIotHighThreatAlarm(false);
                setHighThreatSensor(null);
                if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
              }

              if (gasSmokeSensorRef.current?.sensor_id === sensorId) {
                stickyYellowAlertRef.current = null;
                setGasSmokeAlarm(false);
                setGasSmokeSensor(null);
                if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
              }
            } catch (err) {
              console.warn(
                `❌ [SensorResetSync] Failed to clear sensor ${sensorId}:`,
                err
              );
            }
          })();
        });
      },
      (err) => {
        console.warn('❌ [SensorResetSync] listener error:', err);
      }
    );

    return () => unsub();
  }, []);

  useEffect(() => {
    if (latestDispatchByUnit.size === 0) return;

    setIncidents(prev => {
      let changed = false;
      const next = prev.map(inc => {
        const normalized = normalizeIncidentStatus(inc.status);
        if (normalized === 'Resolved' || normalized === 'Cancelled') {
          resolvedIncidentIdsRef.current.add(inc.incident_id);
          return inc;
        }

        if (resolvedIncidentIdsRef.current.has(inc.incident_id)) {
          changed = true;
          return {
            ...inc,
            status: 'Resolved' as any,
            resolved_at: (inc as any).resolved_at || new Date().toISOString(),
          } as Incident;
        }

        for (const [, dispatch] of latestDispatchByUnit) {
          if (dispatch.incidentId !== inc.incident_id) continue;
          if (!dispatch.isTerminal) continue;
          if (!dispatch.resolved) continue;

          resolvedIncidentIdsRef.current.add(inc.incident_id);
          changed = true;
          return {
            ...inc,
            status: 'Resolved' as any,
            resolved_at: dispatch.resolvedAt
              ? coerceTimestampToIso(dispatch.resolvedAt)
              : ((inc as any).resolved_at || new Date().toISOString()),
            resolved_by_unit: dispatch.resolvedByUnit || (inc as any).resolved_by_unit,
          } as Incident & { resolved_at?: string; resolved_by_unit?: string };
        }
        return inc;
      });
      return changed ? next : prev;
    });
  }, [latestDispatchByUnit]);

  useEffect(() => {
    if (!unitsLoaded) return;

    console.log('🛰️ [UnitGPS] Starting real-time unit tracking listener');

    const unitsRef = collection(firestore, 'units');
    const unsub = onSnapshot(unitsRef, (snapshot) => {
      const liveUnits: ResponseUnit[] = [];

      snapshot.forEach(docSnap => {
        const d = docSnap.data() as any;

        const lat = parseCoord(d.latitude);
        const lng = parseCoord(d.longitude);

        liveUnits.push({
          ...d,
          unit_id: docSnap.id,
          latitude: lat,
          longitude: lng,
          status: d.status || 'Available',
          current_incident_id: d.current_incident_id ?? null,
          last_active: d.last_active ?? d.last_update ?? null,
          last_update: d.last_update ?? d.last_active ?? null,
          is_online: d.is_online,
        } as ResponseUnit);
      });

      if (liveUnits.length === 0) return;

      setUnits(prev => {
        const liveMap = new Map(liveUnits.map(u => [u.unit_id, u]));
        const merged: ResponseUnit[] = [...liveUnits];

        prev.forEach(u => {
          if (!liveMap.has(u.unit_id)) {
            merged.push(u);
          }
        });

        if (import.meta.env.DEV) {
          prev.forEach(prevUnit => {
            const live = liveMap.get(prevUnit.unit_id);
            if (live && hasValidCoords(prevUnit) && hasValidCoords(live)) {
              const moved =
                Math.abs(prevUnit.latitude - live.latitude) > 0.00001 ||
                Math.abs(prevUnit.longitude - live.longitude) > 0.00001;
              if (moved) {
                console.log(
                  `🚒 [UnitGPS] ${live.unit_name || live.unit_id} moved: ` +
                  `${prevUnit.latitude.toFixed(5)},${prevUnit.longitude.toFixed(5)} → ` +
                  `${live.latitude.toFixed(5)},${live.longitude.toFixed(5)}`
                );
              }
            }
          });
        }

        return merged;
      });
    }, (err) => {
      console.warn('🚒 [UnitGPS] units collection listener error:', err);
    });

    return () => {
      console.log('🛰️ [UnitGPS] Stopping real-time unit tracking listener');
      unsub();
    };
  }, [unitsLoaded]);

  const activeCallsLookup = useCallback((callId: string): MobileEmergencyCall | null => {
    const found = mobileEmergencies.find(e => e.callId === callId || e.id === callId);
    if (found) return found;
    if (incomingCall && (incomingCall.callId === callId || incomingCall.id === callId)) return incomingCall;
    return null;
  }, [mobileEmergencies, incomingCall]);

  activeCallsLookupRef.current = activeCallsLookup;
  startWebRTCCallRef.current = startWebRTCCall;
  handleWebRTCAnswerRef.current = handleWebRTCAnswer;
  handleWebRTCOfferRef.current = handleWebRTCOffer;
  handleRemoteICECandidateRef.current = handleRemoteICECandidate;
  handleCallerEndedCallRef.current = handleCallerEndedCall;

  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || 'http://localhost:5000';
    const maxReconnectAttempts = 10;

    const newSocket: Socket = io(wsUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true, reconnectionAttempts: maxReconnectAttempts,
      reconnectionDelay: 1000, reconnectionDelayMax: 5000,
      timeout: 10000, forceNew: true,
    });

    setSocket(newSocket);
    socketRef.current = newSocket;

    newSocket.onAny((eventName: string, ...args: any[]) => {
      console.log('🔔 [SOCKET EVENT]', eventName, args);
    });

    newSocket.on('connect', () => {
      setWsConnected(true);
      setWsReconnecting(false);
      setSystemStatus(prev => ({ ...prev, emergencyBroadcast: 'active', network: 'online', lastUpdated: new Date() }));
      const dispatcherName = getDispatcherName();
      newSocket.emit('join_dispatcher', {
        userId: user?.personnel_id || user?.uid || 'dispatcher',
        userName: dispatcherName, displayName: dispatcherName,
        fullName: dispatcherName, dispatcherName,
        role: 'dispatcher', timestamp: new Date().toISOString()
      });
    });

    newSocket.on('disconnect', (reason: string) => {
      setWsConnected(false);
      setSystemStatus(prev => ({ ...prev, emergencyBroadcast: 'inactive', lastUpdated: new Date() }));
      if (reason === 'io server disconnect') {
        setWsReconnecting(true);
        setTimeout(() => { if (!newSocket.connected) newSocket.connect(); }, 2000);
      }
    });

    newSocket.on('reconnect', () => {
      setWsConnected(true);
      setWsReconnecting(false);
      const dispatcherName = getDispatcherName();
      newSocket.emit('join_dispatcher', {
        userId: user?.personnel_id || user?.uid || 'dispatcher',
        userName: dispatcherName, displayName: dispatcherName,
        dispatcherName, role: 'dispatcher', timestamp: new Date().toISOString()
      });
      setSystemStatus(prev => ({ ...prev, emergencyBroadcast: 'active', lastUpdated: new Date() }));
    });

    newSocket.on('request_webrtc_offer', async (data: any) => {
      console.log('📥 [WebRTC] Mobile requested offer:', data);
      const requestedCallId = data?.callId;
      if (!requestedCallId) return;

      if (processedIdsRef.current.has(requestedCallId)) {
        console.log('📥 [WebRTC] Call already processed/ended — ignoring offer request');
        return;
      }

      if (peerConnectionRef.current && currentCallIdRef.current === requestedCallId) {
        console.log('📥 [WebRTC] PC exists for this call — re-sending offer');
        try {
          const pc = peerConnectionRef.current;
          if (pc.localDescription && pc.localDescription.type === 'offer') {
            newSocket.emit('webrtc_offer', {
              callId: requestedCallId,
              offer: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp,
              },
              from: 'dispatcher',
            });
            console.log('📤 [WebRTC] Re-sent existing offer');
          }
        } catch (err) {
          console.error('❌ [WebRTC] Failed to re-send offer:', err);
        }
        return;
      }

      const call = activeCallsLookupRef.current(requestedCallId);
      if (!call) {
        console.log('📥 [WebRTC] No active call for', requestedCallId, '— ignoring');
        return;
      }

      const callerName = call.caller_name || 'Caller';
      const callerPhone = call.caller_phone || '';

      try {
        await startWebRTCCallRef.current(requestedCallId, callerName, callerPhone);
        console.log('✅ [WebRTC] Offer sent in response to mobile request');
      } catch (err) {
        console.error('❌ [WebRTC] Failed to auto-start call:', err);
      }
    });

    newSocket.on('caller_ended_call', (data: any) => {
      console.log('🔴 [Socket] caller_ended_call:', data);
      handleCallerEndedCallRef.current(data);
    });
    newSocket.on('caller_end_call', (data: any) => {
      console.log('🔴 [Socket] caller_end_call:', data);
      handleCallerEndedCallRef.current(data);
    });
    newSocket.on('end_call_by_caller', (data: any) => {
      console.log('🔴 [Socket] end_call_by_caller:', data);
      handleCallerEndedCallRef.current(data);
    });
    newSocket.on('call_ended_by_caller', (data: any) => {
      console.log('🔴 [Socket] call_ended_by_caller:', data);
      handleCallerEndedCallRef.current(data);
    });
    newSocket.on('call_ended', (data: any) => {
      console.log('🔴 [Socket] call_ended:', data);
      handleCallerEndedCallRef.current({
        callId: data?.callId || data?.call_id || currentCallIdRef.current || incomingCallRef.current?.callId || incomingCallRef.current?.id,
        userName: data?.userName || data?.caller_name || 'Caller',
      });
    });
    newSocket.on('end_call', (data: any) => {
      console.log('🔴 [Socket] end_call:', data);
      handleCallerEndedCallRef.current({
        callId: data?.callId || data?.call_id || currentCallIdRef.current || incomingCallRef.current?.callId || incomingCallRef.current?.id,
        userName: data?.userName || data?.caller_name || 'Caller',
      });
    });

    newSocket.on('webrtc_answer', async (data: any) => {
      console.log('📥 [WebRTC] Received webrtc_answer:', data);
      if (data.answer) {
        await handleWebRTCAnswerRef.current(data.answer);
      }
    });

    newSocket.on('webrtc_offer', async (data: any) => {
      console.log('📥 [WebRTC] Received webrtc_offer:', data);
      if (data.offer && data.callId) {
        await handleWebRTCOfferRef.current(data.offer, data.callId);
      }
    });

    newSocket.on('webrtc_ice_candidate', async (data: any) => {
      console.log('🧊 [WebRTC] Received webrtc_ice_candidate:', data);
      if (data.candidate && data.from !== 'dispatcher') {
        await handleRemoteICECandidateRef.current(data.candidate);
      }
    });

    newSocket.on('webrtc_call_ended', (data: any) => {
      console.log('📞 [WebRTC] Remote peer ended call:', data);
      handleCallerEndedCallRef.current({
        callId: data?.callId || currentCallIdRef.current,
        userName: data?.userName || 'Caller',
      });
    });

    newSocket.on('webrtc_call_rejected', (data: any) => {
      console.log('📞 [WebRTC] Call rejected:', data);
      setCallState({
        callId: null, isActive: false, isConnected: false, isMuted: false,
        isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
      });
      cleanupWebRTC();
      setShowIncomingCall(false);
      setIsCallConnected(false);
      setIncomingCall(null);
      toast.error('📞 Call was rejected');
    });

    newSocket.on('incoming_call', async (data: any) => {
      const callId = data.callId || `ws_${Date.now()}`;
      if (processedIdsRef.current.has(callId)) return;

      if (!hasValidCoords(data)) {
        console.warn('📞 [Socket] incoming_call missing valid coords — ignoring', data);
        return;
      }

      let address = data.location_address || data.address || '';
      if (!address || address.trim() === '') address = await getAddressFromCoords(data.latitude, data.longitude);

      const dispatcherName = getDispatcherName();
      const emergency: MobileEmergencyCall = {
        id: callId, callId: data.callId || callId,
        userId: data.userId || data.uid || 'unknown',
        caller_name: getCallerName(data), caller_phone: getCallerPhone(data, 'Unknown'),
        latitude: data.latitude, longitude: data.longitude,
        timestamp: data.timestamp || Date.now(), address,
        status: 'Received', source: 'mobile_app', acknowledged: false,
        accuracy: data.accuracy, provider: data.provider,
        dispatcher_name: dispatcherName,
      };

      mirrorEmergencyOnce(emergency).catch(err =>
        console.warn('🪞 [HistoryMirror] socket emergency mirror failed:', err)
      );

      processedIdsRef.current.add(callId);
      activeIncomingCallIdRef.current = callId;
      setMobileEmergencies(prev => [...prev, emergency]);
      previousEmergenciesRef.current.set(callId, emergency);
      setIncomingCall(emergency);
      setShowIncomingCall(true);
      setIsCallConnected(false);
      if (ringtoneAudioRef.current) ringtoneAudioRef.current.play().catch(() => { });
      toast.error(`📞 INCOMING CALL from ${emergency.caller_name}!`, { duration: 10000, icon: '📞' });
      if (incomingCallTimeoutRef.current) clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = window.setTimeout(() => {
        stopRingtone();
        setShowIncomingCall(false);
        activeIncomingCallIdRef.current = null;
        setTimeout(() => setIncomingCall(null), 500);
      }, 30000);
      if (mapRef.current) {
        mapRef.current.panTo({ lat: emergency.latitude, lng: emergency.longitude });
        mapRef.current.setZoom(16);
      }
    });

    newSocket.on('caller_joined', async (data: any) => {
      if (!hasValidCoords(data)) {
        console.warn('📞 [Socket] caller_joined missing valid coords — ignoring', data);
        return;
      }

      const callId = data.callId || `ws_${Date.now()}`;
      if (processedIdsRef.current.has(callId)) return;
      let address = data.location_address || data.address || '';
      if (!address || address.trim() === '') address = await getAddressFromCoords(data.latitude, data.longitude);
      const dispatcherName = getDispatcherName();
      const emergency: MobileEmergencyCall = {
        id: callId, callId: data.callId || callId,
        userId: data.userId || data.uid || 'unknown',
        caller_name: getCallerName(data), caller_phone: getCallerPhone(data, 'Unknown'),
        latitude: data.latitude, longitude: data.longitude,
        timestamp: data.timestamp || Date.now(), address,
        status: 'Received', source: 'mobile_app', acknowledged: false,
        dispatcher_name: dispatcherName,
      };

      mirrorEmergencyOnce(emergency).catch(err =>
        console.warn('🪞 [HistoryMirror] socket caller_joined mirror failed:', err)
      );

      processedIdsRef.current.add(callId);
      activeIncomingCallIdRef.current = callId;
      setMobileEmergencies(prev => [...prev, emergency]);
      previousEmergenciesRef.current.set(callId, emergency);
      setIncomingCall(emergency);
      setShowIncomingCall(true);
      setIsCallConnected(false);
      if (ringtoneAudioRef.current) ringtoneAudioRef.current.play().catch(() => { });
      toast.error(`📞 INCOMING CALL from ${emergency.caller_name}!`, { duration: 10000, icon: '📞' });
      if (incomingCallTimeoutRef.current) clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = window.setTimeout(() => {
        stopRingtone();
        setShowIncomingCall(false);
        activeIncomingCallIdRef.current = null;
        setTimeout(() => setIncomingCall(null), 500);
      }, 30000);
    });

    newSocket.on('call_acknowledged', (data: any) => {
      if (data?.callId && processedIdsRef.current.has(data.callId)) {
        console.log('📞 [Socket] call_acknowledged for already-ended call — ignoring');
        return;
      }
      const dispatcherName = data.dispatcherName || data.acknowledged_by_name || data.dispatcherDisplayName || 'Dispatcher';
      stopRingtone();
      setIsCallConnected(true);
      setTimeout(() => {
        setShowIncomingCall(false);
        setIncomingCall(null);
        activeIncomingCallIdRef.current = null;
      }, 500);
      if (data.callId) {
        setMobileEmergencies(prev => prev.map(e =>
          e.callId === data.callId || e.id === data.callId ? {
            ...e, acknowledged: true, acknowledged_at: new Date().toISOString(),
            acknowledged_by: 'dispatcher', acknowledged_by_name: dispatcherName,
            dispatcher_name: dispatcherName,
          } : e));
      }
    });

    newSocket.on('call_connected', (data: any) => {
      if (data?.callId && processedIdsRef.current.has(data.callId)) {
        console.log('📞 [Socket] call_connected for already-ended call — ignoring');
        return;
      }
      setIsCallConnected(true);

      if (callTimerRef.current === null && callState.isActive) {
        startCallTimer();
      }
    });

    newSocket.on('call_ended_by_dispatcher', (_data: any) => {
      setIsCallConnected(false);
      setShowIncomingCall(false);
      setIncomingCall(null);
      activeIncomingCallIdRef.current = null;
      setCallState({
        callId: null, isActive: false, isConnected: false, isMuted: false,
        isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
      });
      cleanupWebRTC();
    });

    newSocket.on('call_dismissed', (data: any) => {
      setIsCallConnected(false);
      setShowIncomingCall(false);
      setIncomingCall(null);
      activeIncomingCallIdRef.current = null;
      setCallState({
        callId: null, isActive: false, isConnected: false, isMuted: false,
        isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
      });
      cleanupWebRTC();
      if (data.callId) { processedIdsRef.current.delete(data.callId); previousEmergenciesRef.current.delete(data.callId); }
    });

    newSocket.on('dispatcher_end_call_ack', (data: any) => {
      console.log('✅ Server confirmed end call broadcast:', data);
    });

    newSocket.on('peer_disconnected', (data: any) => {
      if (data.reason === 'caller_disconnected') {
        handleCallerEndedCallRef.current({
          callId: data.callId,
          userName: data.userName || 'Caller',
        });
      }
    });

    newSocket.on('call_disconnected', (data: any) => {
      if (data.reason === 'caller_disconnected') {
        handleCallerEndedCallRef.current({
          callId: data.callId,
          userName: data.userName || 'Caller',
        });
      }
    });

    const handleNetworkOnline = () => { if (!newSocket.connected) newSocket.connect(); };
    const handleNetworkOffline = () => {
      setWsConnected(false);
      setSystemStatus(prev => ({ ...prev, network: 'offline', lastUpdated: new Date() }));
    };

    window.addEventListener('online', handleNetworkOnline);
    window.addEventListener('offline', handleNetworkOffline);

    return () => {
      window.removeEventListener('online', handleNetworkOnline);
      window.removeEventListener('offline', handleNetworkOffline);
      newSocket.disconnect();
      socketRef.current = null;
    };
  }, [user, getDispatcherName, stopRingtone]);

  const acknowledgeCallViaSocket = useCallback((callId: string) => {
    if (socket && socket.connected) {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
      socket.emit('acknowledge_call', {
        callId, dispatcherId, dispatcherName,
        dispatcherDisplayName: dispatcherName,
        acknowledgedBy: dispatcherName,
        acknowledged_by: dispatcherName,
        acknowledged_by_name: dispatcherName,
        timestamp: new Date().toISOString(),
      });
      setIsCallConnected(true);
    }
  }, [socket, user, getDispatcherName]);

  const endCallViaSocket = useCallback((callId: string, callerName?: string, userId?: string) => {
    const dispatcherName = getDispatcherName();
    const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
    const endCallData = {
      callId, dispatcherId, dispatcherName,
      dispatcherDisplayName: dispatcherName,
      endedBy: dispatcherName, ended_by: dispatcherName,
      userName: callerName || 'caller', userId: userId || '',
      timestamp: new Date().toISOString(),
    };
    if (socket && socket.connected) {
      socket.emit('call_ended', endCallData);
      socket.emit('call_ended_by_dispatcher', endCallData);
      socket.emit('end_call', endCallData);
      socket.emit('dispatcher_end_call', endCallData);
      socket.emit('webrtc_call_ended', {
        callId,
        endedBy: 'dispatcher',
        timestamp: new Date().toISOString(),
      });
    }
    setIsCallConnected(false);
  }, [socket, user, getDispatcherName]);

  const dismissCallViaSocket = useCallback((callId: string) => {
    if (socket && socket.connected) {
      const dispatcherName = getDispatcherName();
      socket.emit('call_dismissed', {
        callId,
        dispatcherId: user?.personnel_id || user?.uid || 'dispatcher',
        dispatcherName, dispatcherDisplayName: dispatcherName,
        dismissedBy: dispatcherName, dismissed_by: dispatcherName,
        timestamp: new Date().toISOString(),
      });
    }
  }, [socket, user, getDispatcherName]);

  const handleLoadScript = useCallback(() => {
    console.log('✅ [Google Maps] SDK loaded');
    mapLoadedRef.current = true;
    setMapLoaded(true);
  }, []);

  const handleLoadScriptError = useCallback((err: Error) => {
    console.error('❌ [Google Maps] Failed to load SDK:', err);
    mapLoadedRef.current = true;
    setMapLoaded(true);
    toast.error('Failed to load Google Maps. Check your API key and network connection.');
  }, []);

  const handleZoomIn = () => { if (mapRef.current) { const n = mapZoom + 1; setMapZoom(n); mapRef.current.setZoom(n); } };
  const handleZoomOut = () => { if (mapRef.current) { const n = mapZoom - 1; setMapZoom(n); mapRef.current.setZoom(n); } };

  const clearRoute = useCallback(() => {
    console.log('🧹 [Route] Clearing route (permanent)');

    if (polylineRef.current) {
      try {
        polylineRef.current.setMap(null);
        console.log('🧹 [Route] Polyline detached via setMap(null)');
      } catch (e) {
        console.warn('🧹 [Route] Failed to detach polyline:', e);
      }
      polylineRef.current = null;
    }

    routeClearedRef.current = true;

    setRouteData(null);
    setShowRoute(false);
    setRouteOrigin(null);
    setRouteDestination(null);
    setRouteError(null);
    setRouteLoading(false);

    setRouteKey(prev => prev + 1);

    toast.success('Route cleared from map');
  }, []);

  const handleResetView = () => {
    setMapCenter(FIRE_STATION_LOCATION);
    clearRoute();
    if (mapRef.current) { mapRef.current.panTo(FIRE_STATION_LOCATION); mapRef.current.setZoom(15); setMapZoom(15); }
    if (myLocationMarker) {
      const c = (myLocationMarker as unknown as { _circle?: google.maps.Circle | null })._circle;
      if (c) c.setMap(null);
      myLocationMarker.setMap(null);
      setMyLocationMarker(null);
      setShowMyLocation(false);
    }
    toast.success('Map view reset to Fire Station location');
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) { document.documentElement.requestFullscreen(); setIsFullscreen(true); }
    else { document.exitFullscreen(); setIsFullscreen(false); }
  };

  const handleMapClick = useCallback((e: google.maps.MapMouseEvent) => { if (e.latLng) setSelectedMarker(null); }, []);

  const getMyLocation = useCallback((): Promise<{ lat: number; lng: number }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Geolocation is not supported')); return; }
      navigator.geolocation.getCurrentPosition(
        (position) => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
        (error) => {
          let errorMessage = 'Unable to get your location';
          switch (error.code) {
            case error.PERMISSION_DENIED: errorMessage = 'Location permission denied.'; break;
            case error.POSITION_UNAVAILABLE: errorMessage = 'Location information is unavailable.'; break;
            case error.TIMEOUT: errorMessage = 'Location request timed out.'; break;
          }
          reject(new Error(errorMessage));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }, []);

  const handleMyLocation = () => {
    if (showMyLocation && myLocationMarker) {
      const circle = (myLocationMarker as unknown as { _circle?: google.maps.Circle | null })._circle;
      if (circle) {
        circle.setMap(null);
        (myLocationMarker as unknown as { _circle?: google.maps.Circle | null })._circle = null;
      }

      myLocationMarker.setMap(null);
      setMyLocationMarker(null);
      setShowMyLocation(false);
      setMyLocation(null);

      locationRequestIdRef.current += 1;

      toast.success('📍 My location hidden');
      return;
    }

    const requestId = ++locationRequestIdRef.current;
    setIsGettingLocation(true);
    toast.loading('Getting your location...', { id: 'location-loading' });

    getMyLocation()
      .then((location) => {
        if (requestId !== locationRequestIdRef.current) {
          console.log('📍 [MyLocation] Stale request — ignoring response');
          return;
        }

        setMyLocation(location);
        setShowMyLocation(true);
        setMapCenter(location);

        if (mapRef.current) {
          mapRef.current.panTo(location);
          mapRef.current.setZoom(16);
        }

        if (myLocationMarker) {
          const oldCircle = (myLocationMarker as unknown as { _circle?: google.maps.Circle | null })._circle;
          if (oldCircle) oldCircle.setMap(null);
          myLocationMarker.setMap(null);
        }

        const marker = new google.maps.Marker({
          position: location,
          map: mapRef.current,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            fillColor: '#4285F4',
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 3,
            scale: 10,
          },
          title: 'Your Location',
          zIndex: 1000,
        });

        const circle = new google.maps.Circle({
          center: location,
          radius: 50,
          map: mapRef.current,
          fillColor: '#4285F4',
          fillOpacity: 0.15,
          strokeColor: '#4285F4',
          strokeOpacity: 0.4,
          strokeWeight: 2,
          zIndex: 999,
        });

        (marker as google.maps.Marker & { _circle?: google.maps.Circle })._circle = circle;
        setMyLocationMarker(marker);

        toast.success('📍 Showing your current location', { id: 'location-loading' });
        setIsGettingLocation(false);
        setSystemStatus(prev => ({ ...prev, gps: 'online', lastUpdated: new Date() }));
      })
      .catch((error: Error) => {
        if (requestId !== locationRequestIdRef.current) return;
        toast.error(error.message || 'Unable to get your location', { id: 'location-loading' });
        setIsGettingLocation(false);
        setSystemStatus(prev => ({ ...prev, gps: 'error', lastUpdated: new Date() }));
      });
  };

  useEffect(() => {
    return () => {
      if (myLocationMarker) {
        const c = (myLocationMarker as unknown as { _circle?: google.maps.Circle | null })._circle;
        if (c) c.setMap(null);
        myLocationMarker.setMap(null);
      }
    };
  }, [myLocationMarker]);

  const beginNewRoute = useCallback(() => {
    routeClearedRef.current = false;
  }, []);

  const routeBFPToIncident = async (incident: Incident) => {
    if (!hasValidCoords(incident)) {
      toast.error('Cannot route — incident has no valid coordinates');
      return;
    }
    beginNewRoute();
    setRouteLoading(true); setRouteError(null);
    try {
      const result = await routingManager.routeBFPToIncident(incident);
      if (result) {
        setRouteData(result); setShowRoute(true);
        setRouteOrigin({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng, name: 'BFP Fire Station', type: 'unit' });
        setRouteDestination({ lat: incident.latitude, lng: incident.longitude, name: `Caller Location: ${incident.incident_id}` });
        setRouteKey(prev => prev + 1);
        if (mapRef.current && result.route.length > 0) {
          const bounds = new google.maps.LatLngBounds();
          result.route.forEach(point => bounds.extend(new google.maps.LatLng(point.lat, point.lng)));
          mapRef.current.fitBounds(bounds);
        }
        toast.success(`Route: ${result.distance_text} | ETA: ${result.duration_text}`);
      }
    } catch (error) { const err = error as Error; setRouteError(err.message); toast.error(`Failed: ${err.message}`); }
    finally { setRouteLoading(false); }
  };

  const routeBFPToMobileEmergency = async (location: { lat: number; lng: number; name: string }) => {
    if (!isValidCoord(location.lat, location.lng)) {
      toast.error('Cannot route — invalid coordinates');
      return;
    }
    beginNewRoute();
    setRouteLoading(true); setRouteError(null);
    try {
      const result = await routingManager.routeBFPToMobileEmergency({ lat: location.lat, lng: location.lng });
      if (result) {
        setRouteData(result); setShowRoute(true);
        setRouteOrigin({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng, name: 'BFP Fire Station', type: 'unit' });
        setRouteDestination({ lat: location.lat, lng: location.lng, name: `Emergency: ${location.name}` });
        setRouteKey(prev => prev + 1);
        if (mapRef.current && result.route.length > 0) {
          const bounds = new google.maps.LatLngBounds();
          result.route.forEach(point => bounds.extend(new google.maps.LatLng(point.lat, point.lng)));
          mapRef.current.fitBounds(bounds);
        }
        toast.success(`Route: ${result.distance_text} | ETA: ${result.duration_text}`);
      }
    } catch (error) { const err = error as Error; setRouteError(err.message); toast.error(`Failed: ${err.message}`); }
    finally { setRouteLoading(false); }
  };

  const routeBFPToSensor = async (sensor: SensorWithThreat) => {
    if (!hasValidCoords(sensor)) {
      toast.error('Cannot route — sensor has no valid coordinates');
      return;
    }
    beginNewRoute();
    setRouteLoading(true); setRouteError(null);
    try {
      const result = await routingManager.routeBFPToSensor(sensor);
      if (result) {
        setRouteData(result); setShowRoute(true);
        setRouteOrigin({ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng, name: 'BFP Fire Station', type: 'unit' });
        setRouteDestination({ lat: sensor.latitude, lng: sensor.longitude, name: `Sensor: ${sensor.sensor_id}` });
        setRouteKey(prev => prev + 1);
        if (mapRef.current && result.route.length > 0) {
          const bounds = new google.maps.LatLngBounds();
          result.route.forEach(point => bounds.extend(new google.maps.LatLng(point.lat, point.lng)));
          mapRef.current.fitBounds(bounds);
        }
        toast.success(`Route: ${result.distance_text} | ETA: ${result.duration_text}`);
      }
    } catch (error) { const err = error as Error; setRouteError(err.message); toast.error(`Failed: ${err.message}`); }
    finally { setRouteLoading(false); }
  };

  const routeUnitToIncident = async (unit: ResponseUnit, incident: Incident) => {
    if (!hasValidCoords(unit) || !hasValidCoords(incident)) {
      toast.error('Cannot route — missing valid coordinates');
      return;
    }
    beginNewRoute();
    setRouteLoading(true); setRouteError(null);
    try {
      const result = await routingManager.routeUnitToIncident(unit, incident);
      if (result) {
        setRouteData(result); setShowRoute(true);
        setRouteOrigin({ lat: unit.latitude, lng: unit.longitude, name: `${unit.unit_name}`, type: 'unit' });
        setRouteDestination({ lat: incident.latitude, lng: incident.longitude, name: `Caller Location` });
        setRouteKey(prev => prev + 1);
        if (mapRef.current && result.route.length > 0) {
          const bounds = new google.maps.LatLngBounds();
          result.route.forEach(point => bounds.extend(new google.maps.LatLng(point.lat, point.lng)));
          mapRef.current.fitBounds(bounds);
        }
        toast.success(`Route: ${result.route.length} pts | ETA: ${result.duration_text}`);
      }
    } catch (error) { const err = error as Error; setRouteError(err.message); toast.error(`Failed: ${err.message}`); }
    finally { setRouteLoading(false); }
  };

  const handleIncomingCallAcknowledge = async () => {
    if (!incomingCall) return;

    const callId = incomingCall.callId || incomingCall.id;
    const docId = incomingCall.id;
    const callerName = incomingCall.caller_name || 'Unknown Caller';
    const callerPhone = incomingCall.caller_phone || 'No caller ID';

    callStartTimeRef.current = Date.now();

    stopRingtone();
    if (incomingCallTimeoutRef.current) {
      clearTimeout(incomingCallTimeoutRef.current);
      incomingCallTimeoutRef.current = null;
    }

    processedIdsRef.current.add(docId);
    if (callId && callId !== docId) processedIdsRef.current.add(callId);

    const existingEmergency = previousEmergenciesRef.current.get(docId);
    if (existingEmergency) {
      previousEmergenciesRef.current.set(docId, {
        ...existingEmergency,
        acknowledged: true,
        acknowledged_at: new Date().toISOString(),
      });
    }

    activeIncomingCallIdRef.current = null;

    acknowledgeCallViaSocket(callId);

    setCallState({
      callId,
      isActive: true,
      isConnected: false,
      isMuted: false,
      isSpeakerOn: true,
      callDuration: 0,
      callerName,
      callerPhone,
    });
    setIsCallConnected(true);

    try {
      await startWebRTCCall(callId, callerName, callerPhone);
      console.log('🎤 [WebRTC] Voice call initiated');
    } catch (error) {
      console.error('🎤 [WebRTC] Failed to start voice call:', error);
      toast.error('Failed to start voice call. Please check microphone permissions.');
    }

    setTimeout(() => {
      setShowIncomingCall(false);
      setIncomingCall(null);
    }, 200);

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
      const now = new Date().toISOString();

      if (docId) {
        await updateDoc(doc(firestore, 'emergency_locations', docId), {
          acknowledged: true,
          acknowledged_at: now,
          acknowledged_by: dispatcherId,
          acknowledged_by_name: dispatcherName,
          acknowledged_by_display: dispatcherName,
          status: 'Connected',
          dispatcher_name: dispatcherName,
          dispatcher_id: dispatcherId,
        }).catch(err => console.warn('emergency_locations update failed:', err));
      }

      const targetCallId = callId || docId;
      if (targetCallId) {
        try {
          await updateDoc(doc(firestore, 'emergency_calls', targetCallId), {
            acknowledged: true,
            acknowledged_at: now,
            acknowledged_by: dispatcherId,
            acknowledged_by_name: dispatcherName,
            acknowledged_by_display: dispatcherName,
            status: 'Connected',
            dispatcher_name: dispatcherName,
            dispatcher_id: dispatcherId,
          });
          console.log('🔥 [Firestore] emergency_calls updated to Connected for:', targetCallId);
        } catch (err) {
          console.warn('emergency_calls doc update failed:', err);
        }
      }

      setMobileEmergencies(prev => prev.map(e =>
        (e.id === docId || e.callId === callId) ? {
          ...e,
          acknowledged: true,
          acknowledged_at: now,
          acknowledged_by: dispatcherId,
          acknowledged_by_name: dispatcherName,
          dispatcher_name: dispatcherName,
          status: 'Acknowledged',
        } : e
      ));

      toast.success(`✅ Emergency from ${callerName} acknowledged — connecting voice call...`);
    } catch (error) {
      console.error('Error acknowledging emergency:', error);
      toast.error('Failed to acknowledge emergency in database');
    }
  };

  const handleIncomingCallDismiss = async () => {
    if (!incomingCall) return;
    const docId = incomingCall.id;
    const callId = incomingCall.callId || incomingCall.id;

    stopRingtone();
    if (incomingCallTimeoutRef.current) { clearTimeout(incomingCallTimeoutRef.current); incomingCallTimeoutRef.current = null; }

    setCallState({
      callId: null, isActive: false, isConnected: false, isMuted: false,
      isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
    });
    stopCallTimer();
    cleanupWebRTC();

    const dispatcherName = getDispatcherName();
    const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
    const now = new Date().toISOString();

    processedIdsRef.current.add(docId);

    const existingEmergency = previousEmergenciesRef.current.get(docId);
    if (existingEmergency) {
      previousEmergenciesRef.current.set(docId, {
        ...existingEmergency,
        acknowledged: true,
        status: 'Dismissed',
      });
    }

    activeIncomingCallIdRef.current = null;

    try {
      if (docId) {
        await updateDoc(doc(firestore, 'emergency_locations', docId), {
          status: 'Dismissed', dismissed_at: now,
          dismissed_by: dispatcherId, dismissed_by_name: dispatcherName,
          acknowledged: true, acknowledged_at: now,
          acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
          dispatcher_name: dispatcherName, active: false, call_ended: true,
        }).catch(err => console.warn('emergency_locations dismiss failed:', err));
      }
      if (callId && callId !== docId) {
        try {
          await updateDoc(doc(firestore, 'emergency_calls', callId), {
            status: 'Dismissed', dismissed_at: now,
            dismissed_by: dispatcherId, dismissed_by_name: dispatcherName,
            acknowledged: true, acknowledged_at: now,
            acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
            dispatcher_name: dispatcherName, active: false, call_ended: true,
          });
        } catch (err) {
          console.warn('emergency_calls doc update skipped:', err);
        }
      }
      setMobileEmergencies(prev => prev.map(e =>
        (e.id === docId || e.callId === callId) ? {
          ...e, acknowledged: true, acknowledged_at: now,
          acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
          dispatcher_name: dispatcherName, status: 'Dismissed'
        } : e));
      dismissCallViaSocket(callId);
    } catch (error) { console.error('Error dismissing emergency:', error); }

    setShowIncomingCall(false);
    setIsCallConnected(false);
    toast(`📞 Call from ${incomingCall.caller_name || 'caller'} dismissed by ${dispatcherName}`, { icon: 'ℹ️' });

    if (dismissCooldownRef.current) clearTimeout(dismissCooldownRef.current);
    dismissCooldownRef.current = window.setTimeout(() => {
      const stillUnack = previousEmergenciesRef.current.get(docId);
      if (stillUnack && !stillUnack.acknowledged) {
        processedIdsRef.current.delete(docId);
        previousEmergenciesRef.current.delete(docId);
      }
      dismissCooldownRef.current = null;
    }, 60000);
    setIncomingCall(null);
  };

  const handleEndCall = async () => {
    const activeCallId = callState.callId || incomingCall?.callId || incomingCall?.id || currentCallIdRef.current;
    const docId = incomingCall?.id || activeCallId;

    if (!activeCallId) {
      console.log('📞 handleEndCall: No active call');
      setCallState({
        callId: null, isActive: false, isConnected: false, isMuted: false,
        isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
      });
      cleanupWebRTC();
      setShowIncomingCall(false);
      setIsCallConnected(false);
      setIncomingCall(null);
      return;
    }

    const dispatcherName = getDispatcherName();
    const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
    const now = new Date().toISOString();
    const callerName = incomingCall?.caller_name || callState.callerName || 'caller';

    stopRingtone();
    stopAlarmImmediately();
    if (incomingCallTimeoutRef.current) { clearTimeout(incomingCallTimeoutRef.current); incomingCallTimeoutRef.current = null; }

    setCallState({
      callId: null, isActive: false, isConnected: false, isMuted: false,
      isSpeakerOn: true, callDuration: 0, callerName: '', callerPhone: '',
    });
    stopCallTimer();
    cleanupWebRTC();

    if (socket?.connected) {
      socket.emit('webrtc_call_ended', {
        callId: activeCallId,
        endedBy: 'dispatcher',
        timestamp: now,
      });
    }

    if (docId) processedIdsRef.current.add(docId);
    if (activeCallId && activeCallId !== docId) processedIdsRef.current.add(activeCallId);

    const existingEmergency = docId ? previousEmergenciesRef.current.get(docId) : null;
    if (existingEmergency && docId) {
      previousEmergenciesRef.current.set(docId, {
        ...existingEmergency,
        acknowledged: true,
        status: 'Ended',
      });
    }

    activeIncomingCallIdRef.current = null;

    endCallViaSocket(activeCallId, callerName, incomingCall?.userId);

    try {
      if (docId) {
        await updateDoc(doc(firestore, 'emergency_locations', docId), {
          status: 'Ended', ended_at: now,
          ended_by: dispatcherId, ended_by_name: dispatcherName,
          acknowledged: true, active: false, call_ended: true,
        }).catch(() => { });
      }
      if (activeCallId) {
        try {
          await updateDoc(doc(firestore, 'emergency_calls', activeCallId), {
            status: 'Ended', ended_at: now,
            ended_by: dispatcherId, ended_by_name: dispatcherName,
            active: false, acknowledged: true, call_ended: true,
          });
        } catch (err) {
          console.warn('emergency_calls doc update failed:', err);
        }
      }
    } catch (err) { console.error('Error updating Firestore:', err); }

    setShowIncomingCall(false);
    setIncomingCall(null);
    setIsCallConnected(false);
    toast(`📞 Call with ${callerName} ended by ${dispatcherName}`, { icon: 'ℹ️' });
  };

  const acknowledgeMobileEmergency = async (emergency: MobileEmergencyCall): Promise<void> => {
    const docId = emergency.id;
    const callId = emergency.callId;

    if (showIncomingCall && incomingCall &&
      (incomingCall.id === docId || incomingCall.callId === callId)) {
      await handleIncomingCallAcknowledge();
      return;
    }

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
      const now = new Date().toISOString();

      processedIdsRef.current.add(docId);
      if (callId && callId !== docId) processedIdsRef.current.add(callId);

      const existingEmergency = previousEmergenciesRef.current.get(docId);
      if (existingEmergency) {
        previousEmergenciesRef.current.set(docId, { ...existingEmergency, acknowledged: true });
      }

      acknowledgeCallViaSocket(callId || docId);

      if (docId) {
        await updateDoc(doc(firestore, 'emergency_locations', docId), {
          acknowledged: true, acknowledged_at: now,
          acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
          acknowledged_by_display: dispatcherName, status: 'Connected',
          dispatcher_name: dispatcherName, dispatcher_id: dispatcherId,
        }).catch(() => { });
      }

      const targetCallId = callId || docId;
      if (targetCallId) {
        try {
          await updateDoc(doc(firestore, 'emergency_calls', targetCallId), {
            acknowledged: true, acknowledged_at: now,
            acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
            acknowledged_by_display: dispatcherName, status: 'Connected',
            dispatcher_name: dispatcherName, dispatcher_id: dispatcherId,
          });
        } catch (err) {
          console.warn('emergency_calls doc update failed:', err);
        }

        if (!callState.isActive) {
          if (remoteAudioRef.current) {
            remoteAudioRef.current.muted = false;
            remoteAudioRef.current.volume = 1.0;
          }
          startWebRTCCall(targetCallId, emergency.caller_name || 'Caller', emergency.caller_phone || '')
            .catch(err => console.error('Error starting WebRTC from emergency modal:', err));
        }
      }

      setMobileEmergencies(prev => prev.map(e =>
        (e.id === docId || e.callId === callId) ? {
          ...e, acknowledged: true, acknowledged_at: now,
          acknowledged_by: dispatcherId, acknowledged_by_name: dispatcherName,
          dispatcher_name: dispatcherName, status: 'Acknowledged'
        } : e
      ));

      toast.success(`✅ ${dispatcherName} acknowledged emergency from ${emergency.caller_name || 'caller'}`);
      setShowMobileEmergencyModal(false);
    } catch (error) {
      console.error('Error acknowledging emergency:', error);
      toast.error('Failed to acknowledge emergency.');
    }
  };

  const verifyMobileEmergency = async (emergency: MobileEmergencyCall): Promise<void> => {
    if (!user) { toast.error('Please log in'); return; }

    const docId = emergency.id;
    const callId = emergency.callId || emergency.id;

    if (verifiedEmergencyIdsRef.current.has(docId)) {
      toast('Already verified', { icon: 'ℹ️' });
      return;
    }

    setProcessing(true);
    const toastId = toast.loading('Verifying emergency…');

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
      const now = new Date().toISOString();
      const nowTs = Timestamp.now();

      const incidentId = `INC-${Date.now().toString(36).toUpperCase()}-${Math.random()
        .toString(36).slice(2, 6).toUpperCase()}`;

      const incidentPayload: any = {
        incident_id: incidentId,
        latitude: emergency.latitude,
        longitude: emergency.longitude,
        location_address: emergency.address || '',
        threat_level: 'RED',
        status: 'Verified',
        source: 'mobile_app',
        reported_at: new Date(emergency.timestamp).toISOString(),
        description: `Verified mobile emergency call from ${emergency.caller_name || 'Unknown Caller'
          }${emergency.caller_phone ? ` (${emergency.caller_phone})` : ''}`,
        created_at: now,
        updated_at: now,
        verified_at: now,
        verified_by: dispatcherId,
        verified_by_name: dispatcherName,
        emergency_id: docId,
        emergency_call_id: callId,
        caller_name: emergency.caller_name,
        caller_phone: emergency.caller_phone,
        hidden_from_dispatcher: false,
      };

      await addDoc(collection(firestore, 'incidents'), {
        ...incidentPayload,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });

      const verifyFields = {
        verified: true,
        verified_at: now,
        verified_by: dispatcherId,
        verified_by_name: dispatcherName,
        verified_by_display: dispatcherName,
        status: 'Verified',
        acknowledged: true,
        incident_id: incidentId,
        userId: emergency.userId || docId,
        updated_at: nowTs,
      };

      if (docId) {
        await updateDoc(doc(firestore, 'emergency_locations', docId), verifyFields)
          .catch(err => console.warn('emergency_locations verify failed:', err));
      }
      if (callId && callId !== docId) {
        await updateDoc(doc(firestore, 'emergency_calls', callId), verifyFields)
          .catch(err => console.warn('emergency_calls verify failed:', err));
      }

      verifiedEmergencyIdsRef.current.add(docId);
      verifiedEmergencyIdsRef.current.add(callId);
      verifiedIncidentMapRef.current.set(docId, incidentId);
      verifiedIncidentMapRef.current.set(callId, incidentId);

      const prev = previousEmergenciesRef.current.get(docId);
      if (prev) {
        previousEmergenciesRef.current.set(docId, {
          ...prev,
          acknowledged: true,
          verified: true,
          verified_at: now,
          verified_by: dispatcherId,
          verified_by_name: dispatcherName,
          status: 'Verified',
          incident_id: incidentId,
        });
        if (callId && callId !== docId) {
          previousEmergenciesRef.current.set(callId, {
            ...prev,
            acknowledged: true,
            verified: true,
            verified_at: now,
            verified_by: dispatcherId,
            verified_by_name: dispatcherName,
            status: 'Verified',
            incident_id: incidentId,
          });
        }
      }

      setMobileEmergencies(prevList =>
        prevList.map(e =>
          e.id === docId || e.callId === callId
            ? {
              ...e,
              acknowledged: true,
              verified: true,
              verified_at: now,
              verified_by: dispatcherId,
              verified_by_name: dispatcherName,
              status: 'Verified',
              incident_id: incidentId,
            }
            : e
        )
      );

      const optimisticIncident = {
        ...incidentPayload,
        created_at: now,
        updated_at: now,
      } as unknown as Incident;

      setIncidents(prevList => {
        if (prevList.some(i => i.incident_id === incidentId)) return prevList;
        return [optimisticIncident, ...prevList];
      });

      try { await logActivity('verify_emergency', 'incident', incidentId); } catch { /* non-critical */ }

      if (socket?.connected) {
        socket.emit('emergency_verified', {
          callId,
          incidentId,
          dispatcherId,
          dispatcherName,
          verified_at: now,
        });
      }

      toast.success(
        `✅ Verified — created incident ${incidentId} for ${emergency.caller_name || 'caller'}`,
        { id: toastId, duration: 4000 }
      );

      setShowMobileEmergencyModal(false);
      setSelectedMobileEmergency(null);

      if (mapRef.current && hasValidCoords(emergency)) {
        mapRef.current.panTo({ lat: emergency.latitude, lng: emergency.longitude });
        mapRef.current.setZoom(16);
      }
    } catch (error) {
      console.error('Error verifying emergency:', error);
      toast.error('Failed to verify emergency', { id: toastId, duration: 4000 });
    } finally {
      setProcessing(false);
    }
  };

  const acknowledgeSensor = useCallback((sensor: SensorWithThreat) => {
    sensorAckRef.current.add(sensor.sensor_id);

    setSensors(prev => prev.map(s =>
      s.sensor_id === sensor.sensor_id
        ? { ...s, dispatcher_acknowledged: true, dispatcher_acknowledged_at: new Date().toISOString() }
        : s
    ));

    if (highThreatSensor?.sensor_id === sensor.sensor_id) {
      stickyRedAlertRef.current = null;
      setIotHighThreatAlarm(false);
      setHighThreatSensor(null);
      if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
    }

    if (gasSmokeSensor?.sensor_id === sensor.sensor_id) {
      stickyYellowAlertRef.current = null;
      setGasSmokeAlarm(false);
      setGasSmokeSensor(null);
      if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
    }

    toast.success(`✅ Sensor ${sensor.sensor_id} acknowledged`);
  }, [highThreatSensor, gasSmokeSensor]);

  // ============================================================
  // ⭐ verifySensorAndCreateIncident — handles BOTH RED and YELLOW
  // ============================================================
  const verifySensorAndCreateIncident = async (sensor: SensorWithThreat): Promise<void> => {
    if (!user) { toast.error('Please log in'); return; }

    if (sensorVerifiedRef.current.has(sensor.sensor_id)) {
      const existingIncId = sensorVerifiedRef.current.get(sensor.sensor_id)!;
      toast(`Already verified as ${existingIncId}`, { icon: 'ℹ️' });
      const existing = incidents.find(i => i.incident_id === existingIncId);
      if (existing) {
        setSelectedIncident(existing);
        setShowIncidentModal(true);
        setShowSensorModal(false);
      }
      return;
    }

    setProcessing(true);
    const toastId = toast.loading(`Verifying sensor ${sensor.sensor_id}…`);

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
      const now = new Date().toISOString();
      const nowTs = Timestamp.now();

      // ⭐ Use cached sticky threat level so YELLOW/RED is preserved even
      //    if the live doc went stale during verification.
      const cached = stickySensorDataRef.get(sensor.sensor_id);
      const effectiveThreat = cached?.threat_level || sensor.threat_level;
      const isYellow = effectiveThreat === 'YELLOW';
      const threatLevel = isYellow ? 'YELLOW' : 'RED';

      const incidentId = `INC-${Date.now().toString(36).toUpperCase()}-${Math.random()
        .toString(36).slice(2, 6).toUpperCase()}`;

      const locationLabel =
        sensor.location_name ||
        cached?.location_name ||
        sensor.location ||
        cached?.location ||
        [sensor.building, sensor.room, sensor.floor].filter(Boolean).join(', ') ||
        'Unknown Location';

      const description = isYellow
        ? `IoT sensor ${sensor.sensor_id} (${sensor.sensor_type}) detected gas/smoke` +
          (sensor.temperature != null ? ` — ${sensor.temperature}°C` : '') +
          ` at ${locationLabel}.`
        : `IoT sensor ${sensor.sensor_id} (${sensor.sensor_type}) detected fire/flame` +
          (sensor.temperature != null ? ` — ${sensor.temperature}°C` : '') +
          ` at ${locationLabel}.`;

      const lat = hasValidCoords(sensor) ? sensor.latitude : (cached?.latitude ?? 0);
      const lng = hasValidCoords(sensor) ? sensor.longitude : (cached?.longitude ?? 0);

      const incidentPayload: any = {
        incident_id: incidentId,
        latitude: lat,
        longitude: lng,
        location_address: locationLabel,
        threat_level: threatLevel,
        status: 'Verified',
        source: 'iot_sensor',
        reported_at: now,
        description,
        created_at: now,
        updated_at: now,
        verified_at: now,
        verified_by: dispatcherId,
        verified_by_name: dispatcherName,
        sensor_id: sensor.sensor_id,
        sensor_type: sensor.sensor_type,
        building: sensor.building || cached?.building || '',
        room: sensor.room || cached?.room || '',
        floor: sensor.floor || cached?.floor || '',
        temperature: sensor.temperature ?? cached?.temperature ?? null,
        hidden_from_dispatcher: false,
      };

      await addDoc(collection(firestore, 'incidents'), {
        ...incidentPayload,
        created_at: serverTimestamp(),
        updated_at: serverTimestamp(),
      });

      try {
        await updateDoc(doc(firestore, 'sensors', sensor.sensor_id), {
          verified: true,
          verified_at: now,
          verified_by: dispatcherId,
          verified_by_name: dispatcherName,
          incident_id: incidentId,
          dispatcher_acknowledged: true,
          dispatcher_acknowledged_at: now,
          updated_at: nowTs,
        });
      } catch (err) {
        console.warn('sensors verify update failed (non-fatal):', err);
      }

      sensorVerifiedRef.current.set(sensor.sensor_id, incidentId);
      sensorAckRef.current.add(sensor.sensor_id);

      setSensors(prev => prev.map(s =>
        s.sensor_id === sensor.sensor_id
          ? {
            ...s,
            dispatcher_acknowledged: true,
            verified: true,
            verified_at: now,
            verified_by_name: dispatcherName,
            incident_id: incidentId,
          }
          : s
      ));

      // ⭐ Clear the sticky alert + snapshot now that the sensor is verified
      if (highThreatSensor?.sensor_id === sensor.sensor_id) {
        stickyRedAlertRef.current = null;
        setIotHighThreatAlarm(false);
        setHighThreatSensor(null);
        if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
      }

      if (gasSmokeSensor?.sensor_id === sensor.sensor_id) {
        stickyYellowAlertRef.current = null;
        setGasSmokeAlarm(false);
        setGasSmokeSensor(null);
        if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
      }

      // Clear sticky snapshot — the pin will now be blue (verified)
      clearStickySensor(sensor.sensor_id);

      const optimisticIncident = {
        ...incidentPayload,
        created_at: now,
        updated_at: now,
      } as unknown as Incident;

      setIncidents(prevList => {
        if (prevList.some(i => i.incident_id === incidentId)) return prevList;
        return [optimisticIncident, ...prevList];
      });

      try { await logActivity('verify_sensor', 'incident', incidentId); } catch { /* non-critical */ }

      if (socket?.connected) {
        socket.emit('emergency_verified', {
          sensorId: sensor.sensor_id,
          incidentId,
          dispatcherId,
          dispatcherName,
          verified_at: now,
        });
      }

      const typeLabel = isYellow ? 'gas/smoke' : 'fire/flame';
      toast.success(
        `✅ Sensor verified — created incident ${incidentId} (${typeLabel} at ${locationLabel})`,
        { id: toastId, duration: 4000 }
      );

      setSelectedSensor(null);
      setShowSensorModal(false);
      setSelectedIncident(optimisticIncident);
      setShowIncidentModal(true);
      setActiveSidebarTab('incidents');
      setShowOverlay(true);

      if (mapRef.current && isValidCoord(lat, lng)) {
        mapRef.current.panTo({ lat, lng });
        mapRef.current.setZoom(16);
      }
    } catch (error) {
      console.error('Error verifying sensor:', error);
      toast.error('Failed to verify sensor', { id: toastId, duration: 4000 });
    } finally {
      setProcessing(false);
    }
  };

  const deleteMobileEmergency = async (emergency: MobileEmergencyCall): Promise<void> => {
    if (!window.confirm(`⚠️ PERMANENTLY DELETE this emergency call from ${emergency.caller_name || 'caller'}?`)) return;
    const toastId = toast.loading('Deleting emergency call...');
    try {
      if (emergency.id) await deleteDoc(doc(firestore, 'emergency_locations', emergency.id));
      if (emergency.callId && emergency.callId !== emergency.id) {
        try { await deleteDoc(doc(firestore, 'emergency_calls', emergency.callId)); } catch (e) { }
      }

      await cleanupHistoryReports({
        sourceEmergencyId: emergency.id,
        sourceCallId: emergency.callId,
      });

      processedIdsRef.current.delete(emergency.id);
      if (emergency.callId) processedIdsRef.current.delete(emergency.callId);
      previousEmergenciesRef.current.delete(emergency.id);
      if (emergency.callId) previousEmergenciesRef.current.delete(emergency.callId);
      verifiedEmergencyIdsRef.current.delete(emergency.id);
      if (emergency.callId) verifiedEmergencyIdsRef.current.delete(emergency.callId);
      verifiedIncidentMapRef.current.delete(emergency.id);
      if (emergency.callId) verifiedIncidentMapRef.current.delete(emergency.callId);
      resolvedEmergencyIdsRef.current.delete(emergency.id);
      if (emergency.callId) resolvedEmergencyIdsRef.current.delete(emergency.callId);
      setMobileEmergencies(prev => prev.filter(e => e.id !== emergency.id));
      if (selectedMobileEmergency?.id === emergency.id) {
        setShowMobileEmergencyModal(false);
        setSelectedMobileEmergency(null);
      }
      toast.success(`🗑️ Emergency deleted`, { id: toastId, duration: 3000 });
    } catch (error) {
      toast.error(`Failed to delete emergency`, { id: toastId, duration: 4000 });
    }
  };

  const clearAllMobileEmergencies = async (): Promise<void> => {
    if (mobileEmergencies.length === 0) { toast('No emergency calls to delete', { icon: 'ℹ️' }); return; }
    const confirmed = window.confirm(`⚠️ DELETE ALL ${mobileEmergencies.length} emergency calls?`);
    if (!confirmed) return;
    const toastId = toast.loading(`Deleting all ${mobileEmergencies.length} emergency calls...`);
    let deletedCount = 0;
    try {
      for (const emergency of mobileEmergencies) {
        try {
          if (emergency.id) await deleteDoc(doc(firestore, 'emergency_locations', emergency.id));
          if (emergency.callId && emergency.callId !== emergency.id) {
            try { await deleteDoc(doc(firestore, 'emergency_calls', emergency.callId)); } catch (e) { }
          }

          await cleanupHistoryReports({
            sourceEmergencyId: emergency.id,
            sourceCallId: emergency.callId,
          });

          processedIdsRef.current.delete(emergency.id);
          if (emergency.callId) processedIdsRef.current.delete(emergency.callId);
          previousEmergenciesRef.current.delete(emergency.id);
          if (emergency.callId) previousEmergenciesRef.current.delete(emergency.callId);
          verifiedEmergencyIdsRef.current.delete(emergency.id);
          if (emergency.callId) verifiedEmergencyIdsRef.current.delete(emergency.callId);
          verifiedIncidentMapRef.current.delete(emergency.id);
          if (emergency.callId) verifiedIncidentMapRef.current.delete(emergency.callId);
          resolvedEmergencyIdsRef.current.delete(emergency.id);
          if (emergency.callId) resolvedEmergencyIdsRef.current.delete(emergency.callId);
          deletedCount++;
          await new Promise(r => setTimeout(r, 100));
        } catch (err) { console.error('Delete failed:', err); }
      }
      setMobileEmergencies([]);
      setShowMobileEmergencyModal(false);
      setSelectedMobileEmergency(null);
      toast.success(`🗑️ ${deletedCount} emergency calls deleted`, { id: toastId, duration: 3000 });
    } catch (error) { toast.error('Failed to clear emergencies', { id: toastId, duration: 4000 }); }
  };

  const releaseUnitsForIncident = useCallback(async (
    incidentId: string,
    reason: string = 'Incident resolved',
  ): Promise<number> => {
    if (!incidentId) return 0;

    const affectedUnits = unitsRefForWatchdog.current.filter(
      u => u.current_incident_id === incidentId
    );

    const fallbackIds = new Set<string>(
      unitsRefForWatchdog.current
        .filter(u => (u as any).assigned_incident_id === incidentId)
        .map(u => u.unit_id)
    );
    for (const id of fallbackIds) {
      if (!affectedUnits.some(u => u.unit_id === id)) {
        const u = unitsRefForWatchdog.current.find(x => x.unit_id === id);
        if (u) affectedUnits.push(u);
      }
    }

    if (affectedUnits.length === 0) return 0;

    console.log(`♻️ [Release] Releasing ${affectedUnits.length} unit(s) for ${incidentId}`);

    let released = 0;

    for (const unit of affectedUnits) {
      try {
        let snap;
        try {
          const q = query(
            collection(firestore, 'unit_dispatches'),
            where('target_unit_id', '==', unit.unit_id),
            where('incident_id', '==', incidentId)
          );
          snap = await getDocs(q);
        } catch (queryErr) {
          console.warn(
            '♻️ [Release] composite query failed (missing index?) — falling back to single-field query',
            queryErr
          );
          try {
            const q2 = query(
              collection(firestore, 'unit_dispatches'),
              where('target_unit_id', '==', unit.unit_id)
            );
            snap = await getDocs(q2);
          } catch (e2) {
            console.warn('♻️ [Release] fallback query failed too:', e2);
            continue;
          }
        }

        for (const docSnap of snap.docs) {
          const dd = docSnap.data() as any;
          if (dd.incident_id !== incidentId) continue;

          const alreadyTerminal =
            dd.status === 'completed' ||
            dd.status === 'cancelled' ||
            dd.status === 'canceled' ||
            dd.status === 'resolved' ||
            dd.cancelled === true;

          if (alreadyTerminal) continue;

          if (dd.resolved === true || dd.completed === true) {
            console.log(`♻️ [Release] Skipping already-resolved dispatch ${docSnap.id}`);
            continue;
          }

          await updateDoc(doc(firestore, 'unit_dispatches', docSnap.id), {
            status: 'completed',
            completed: true,
            completed_at: serverTimestamp(),
            resolved: true,
            resolved_at: serverTimestamp(),
            cancelled: false,
            cancel_reason: null,
          }).catch(err => console.warn('complete dispatch failed:', err));
        }

        await updateUnitStatus(unit.unit_id, 'Available', null as any);

        setUnits(prev => prev.map(u =>
          u.unit_id === unit.unit_id
            ? { ...u, status: 'Available', current_incident_id: null }
            : u
        ));

        released++;
        console.log(`♻️ [Release] ${unit.unit_name} → Available`);
      } catch (err) {
        console.warn(`♻️ [Release] Failed to release ${unit.unit_id}:`, err);
      }
    }

    return released;
  }, []);

  /**
   * ⭐ Reusable helper: clears any IoT sensor linked to the given incident.
   * Also clears the sticky pin flag + sticky notification ref.
   */
  const clearSensorForIncident = useCallback(async (incidentId: string): Promise<void> => {
    if (!incidentId) return;
    try {
      const sensorIncQuery = query(
        collection(firestore, 'incidents'),
        where('incident_id', '==', incidentId),
        limit(1)
      );
      const sensorIncSnap = await getDocs(sensorIncQuery);

      if (sensorIncSnap.empty) return;

      const incData = sensorIncSnap.docs[0].data() as any;
      const sensorId = incData?.sensor_id;

      if (!sensorId) return;

      await updateDoc(doc(firestore, 'iot_sensors', sensorId), {
        verified: false,
        verified_at: null,
        verified_by: null,
        verified_by_name: null,
        incident_id: null,
        dispatcher_acknowledged: false,
        dispatcher_acknowledged_at: null,
        dispatcher_acknowledged_by: null,
        dispatcher_acknowledged_by_name: null,
        updated_at: serverTimestamp(),
      });

      sensorVerifiedRef.current.delete(sensorId);
      sensorAckRef.current.delete(sensorId);
      clearStickySensor(sensorId);

      setSensors(prev => prev.map(s =>
        s.sensor_id === sensorId
          ? {
            ...s,
            verified: false,
            verified_at: undefined,
            verified_by_name: undefined,
            incident_id: undefined,
            dispatcher_acknowledged: false,
          }
          : s
      ));

      if (highThreatSensorRef.current?.sensor_id === sensorId) {
        stickyRedAlertRef.current = null;
        setIotHighThreatAlarm(false);
        setHighThreatSensor(null);
        if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
      }

      if (gasSmokeSensorRef.current?.sensor_id === sensorId) {
        stickyYellowAlertRef.current = null;
        setGasSmokeAlarm(false);
        setGasSmokeSensor(null);
        if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
      }
    } catch (err) {
      console.warn('❌ [clearSensorForIncident] Failed:', err);
    }
  }, []);

  const deleteIncident = async (incident: Incident): Promise<void> => {
    if (!user) { toast.error('Please log in'); return; }

    if (deleteCooldownRef.current.has(incident.incident_id)) {
      toast('Remove already in progress…', { icon: '⏳' });
      return;
    }
    deleteCooldownRef.current.add(incident.incident_id);

    const confirmed = window.confirm(
      `Remove incident ${incident.incident_id} from the dispatcher map?\n\n` +
      `The record is KEPT in the system — Admin can still see it.`
    );
    if (!confirmed) {
      deleteCooldownRef.current.delete(incident.incident_id);
      return;
    }

    setProcessing(true);
    const toastId = toast.loading(`Removing incident ${incident.incident_id} from map...`);

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';

      await hideIncidentFromDispatcher(
        incident.incident_id,
        dispatcherId,
        dispatcherName,
        `Removed from dispatcher map by ${dispatcherName}`
      );

      try {
        const releasedCount = await releaseUnitsForIncident(
          incident.incident_id,
          `Incident ${incident.incident_id} removed from map by dispatcher`,
        );
        if (releasedCount > 0) {
          toast.success(
            `♻️ ${releasedCount} unit${releasedCount > 1 ? 's' : ''} released back to Available`,
            { duration: 4000, icon: '♻️' }
          );
        }
      } catch (err) {
        console.warn('releaseUnitsForIncident (hide) failed:', err);
      }

      const linkedEmergency = mobileEmergencies.find(
        e => e.incident_id === incident.incident_id
      );

      if (linkedEmergency) {
        const now = new Date().toISOString();
        const unlinkPatch = {
          incident_id: null,
          resolved: true,
          marker_visible: false,
          resolved_at: now,
          resolved_by: dispatcherId,
          resolved_by_name: dispatcherName,
          status: 'Resolved',
        };

        if (linkedEmergency.id) {
          await updateDoc(doc(firestore, 'emergency_locations', linkedEmergency.id), unlinkPatch)
            .catch(err => console.warn('emergency_locations unlink failed:', err));
        }
        if (linkedEmergency.callId && linkedEmergency.callId !== linkedEmergency.id) {
          await updateDoc(doc(firestore, 'emergency_calls', linkedEmergency.callId), unlinkPatch)
            .catch(err => console.warn('emergency_calls unlink failed:', err));
        }

        setMobileEmergencies(prev => prev.map(e =>
          (e.id === linkedEmergency.id || e.callId === linkedEmergency.callId)
            ? { ...e, incident_id: undefined, resolved: true, marker_visible: false, status: 'Resolved' }
            : e
        ));

        [linkedEmergency.id, linkedEmergency.callId].filter(Boolean).forEach(key => {
          const prev = previousEmergenciesRef.current.get(key!);
          if (prev) {
            previousEmergenciesRef.current.set(key!, {
              ...prev,
              incident_id: undefined,
              resolved: true,
              marker_visible: false,
              status: 'Resolved',
            });
          }
          resolvedEmergencyIdsRef.current.add(key!);
        });

        verifiedIncidentMapRef.current.forEach((incId, key) => {
          if (incId === incident.incident_id) {
            verifiedIncidentMapRef.current.delete(key);
          }
        });
      }

      resolvedIncidentIdsRef.current.add(incident.incident_id);
      setIncidents(prev => prev.filter(i => i.incident_id !== incident.incident_id));

      if (selectedIncident?.incident_id === incident.incident_id) {
        setShowIncidentModal(false);
        setSelectedIncident(null);
      }
      if (selectedMarker?.type === 'incident' &&
        selectedMarker.data.incident_id === incident.incident_id) {
        setSelectedMarker(null);
      }

      try {
        await logActivity('hide_incident_from_dispatcher', 'incident', incident.incident_id);
      } catch { /* non-critical */ }

      await clearSensorForIncident(incident.incident_id);

      toast.success(`✅ Incident ${incident.incident_id} removed from map (kept in system)`, {
        id: toastId,
        duration: 3500,
      });
    } catch (error) {
      console.error('Error hiding incident:', error);
      toast.error('Failed to remove incident', { id: toastId, duration: 4000 });
    } finally {
      setProcessing(false);
      window.setTimeout(() => {
        deleteCooldownRef.current.delete(incident.incident_id);
      }, 1500);
    }
  };

  const clearAllIncidents = async (): Promise<void> => {
    if (!user) { toast.error('Please log in'); return; }

    if (incidents.length === 0) {
      toast('No incidents to remove', { icon: 'ℹ️' });
      return;
    }

    const confirmed = window.confirm(
      `Remove all ${incidents.length} incident${incidents.length > 1 ? 's' : ''} from the dispatcher map?\n\n` +
      `The records are KEPT in the system — Admin can still see them.`
    );
    if (!confirmed) return;

    setProcessing(true);
    const toastId = toast.loading(`Removing all ${incidents.length} incidents from map...`);

    try {
      const dispatcherName = getDispatcherName();
      const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';

      const idsToHide = incidents.map(i => i.incident_id);

      const { hidden, failed } = await hideAllIncidentsFromDispatcher(
        idsToHide,
        dispatcherId,
        dispatcherName,
        `Bulk removed from dispatcher map by ${dispatcherName}`
      );

      for (const incident of incidents) {
        try {
          await releaseUnitsForIncident(
            incident.incident_id,
            `Incident ${incident.incident_id} removed from map by dispatcher`,
          );
        } catch (err) {
          console.warn('releaseUnitsForIncident (bulk hide) failed:', err);
        }
      }

      const now = new Date().toISOString();
      for (const incident of incidents) {
        const linkedEmergency = mobileEmergencies.find(
          e => e.incident_id === incident.incident_id
        );
        if (!linkedEmergency) continue;

        const unlinkPatch = {
          incident_id: null,
          resolved: true,
          marker_visible: false,
          resolved_at: now,
          resolved_by: dispatcherId,
          resolved_by_name: dispatcherName,
          status: 'Resolved',
        };

        if (linkedEmergency.id) {
          await updateDoc(doc(firestore, 'emergency_locations', linkedEmergency.id), unlinkPatch)
            .catch(() => { });
        }
        if (linkedEmergency.callId && linkedEmergency.callId !== linkedEmergency.id) {
          await updateDoc(doc(firestore, 'emergency_calls', linkedEmergency.callId), unlinkPatch)
            .catch(() => { });
        }

        [linkedEmergency.id, linkedEmergency.callId].filter(Boolean).forEach(key => {
          resolvedEmergencyIdsRef.current.add(key!);
        });
      }

      idsToHide.forEach(id => resolvedIncidentIdsRef.current.add(id));
      setIncidents([]);
      setShowIncidentModal(false);
      setSelectedIncident(null);
      if (selectedMarker?.type === 'incident') setSelectedMarker(null);

      try {
        await logActivity('hide_all_incidents_from_dispatcher', 'incident', `${hidden} incidents`);
      } catch { /* non-critical */ }

      for (const incident of incidents) {
        await clearSensorForIncident(incident.incident_id);
      }

      if (failed.length === 0) {
        toast.success(`✅ All ${hidden} incidents removed from map (kept in system)`, {
          id: toastId, duration: 3500,
        });
      } else {
        toast.error(
          `Removed ${hidden}/${idsToHide.length}. Failed: ${failed.join(', ')}`,
          { id: toastId, duration: 6000 }
        );
      }
    } catch (error) {
      console.error('Error removing incidents from map:', error);
      toast.error('Failed to remove incidents', { id: toastId, duration: 4000 });
    } finally {
      setProcessing(false);
    }
  };

  const handleFalseAlarm = async (incident: Incident): Promise<void> => {
    if (!user) { toast.error('Please log in'); return; }
    setProcessing(true);
    const toastId = toast.loading('Processing false alarm...');
    try {
      if (!window.confirm(`Mark incident ${incident.incident_id} as false alarm?`)) { toast.dismiss(toastId); setProcessing(false); return; }
      await updateIncidentStatus(incident.incident_id, 'Cancelled', user.personnel_id || 'unknown', incident.status as IncidentStatus);
      setIncidents(prev => prev.map(inc => inc.incident_id === incident.incident_id ? { ...inc, status: 'Cancelled' } : inc));

      resolvedIncidentIdsRef.current.add(incident.incident_id);

      const now = new Date().toISOString();
      const dispatcherName = getDispatcherName();
      const linked = mobileEmergencies.filter(e => e.incident_id === incident.incident_id);

      setMobileEmergencies(prev =>
        prev.map(e =>
          e.incident_id === incident.incident_id
            ? {
              ...e,
              incident_id: undefined,
              resolved: true,
              marker_visible: false,
              resolved_at: now,
              resolved_by: user?.personnel_id || 'dispatcher',
              resolved_by_name: dispatcherName,
              status: 'Cancelled',
            }
            : e
        )
      );

      for (const l of linked) {
        const patch = {
          incident_id: null,
          resolved: true,
          marker_visible: false,
          resolved_at: now,
          resolved_by: user?.personnel_id || 'dispatcher',
          resolved_by_name: dispatcherName,
          status: 'Cancelled',
        };
        if (l.id) await updateDoc(doc(firestore, 'emergency_locations', l.id), patch).catch(() => { });
        if (l.callId && l.callId !== l.id) await updateDoc(doc(firestore, 'emergency_calls', l.callId), patch).catch(() => { });

        if (l.userId) {
          await cleanupHistoryReports({
            sourceEmergencyId: l.id,
            sourceCallId: l.callId,
            markSafe: {
              title: `Cancelled — ${l.caller_name || 'False Alarm'}`,
              description: `Emergency call from ${l.caller_name || 'Unknown Caller'} was marked as a false alarm by ${dispatcherName}. Incident: ${incident.incident_id}.`,
              location:
                l.address ||
                `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}`,
              latitude: l.latitude,
              longitude: l.longitude,
              resolvedFrom: incident.incident_id,
            },
          });
        }

        [l.id, l.callId].filter(Boolean).forEach(key => {
          resolvedEmergencyIdsRef.current.add(key!);
          const prev = previousEmergenciesRef.current.get(key!);
          if (prev) {
            previousEmergenciesRef.current.set(key!, {
              ...prev,
              incident_id: undefined,
              resolved: true,
              marker_visible: false,
              status: 'Cancelled',
            });
          }
        });
      }

      await releaseUnitsForIncident(
        incident.incident_id,
        `Marked as false alarm by ${dispatcherName}`,
      ).catch(err => console.warn('releaseUnitsForIncident failed:', err));

      await clearSensorForIncident(incident.incident_id);

      await logActivity('cancel_incident', 'incident', incident.incident_id);
      toast.success(`✅ Marked as false alarm`, { id: toastId });
      setShowIncidentModal(false);
    } catch (error) { toast.error('Failed to process', { id: toastId }); }
    finally { setProcessing(false); }
  };

  const handleDispatchUnits = async (): Promise<void> => {
    if (!selectedIncident || !user) {
      toast.error('No incident selected');
      return;
    }
    if (!hasValidCoords(selectedIncident)) {
      toast.error('Cannot dispatch — incident has no valid coordinates');
      return;
    }
    if (selectedUnits.length === 0) {
      toast.error('Select at least one unit');
      return;
    }

    const busyUnits = selectedUnits.filter(id => {
      const u = units.find(x => x.unit_id === id);
      return u && u.status !== 'Available';
    });
    if (busyUnits.length > 0) {
      const busyNames = busyUnits
        .map(id => units.find(u => u.unit_id === id)?.unit_name || id)
        .join(', ');
      toast.error(`Cannot dispatch — ${busyNames} no longer available`);
      setSelectedUnits(prev => prev.filter(id => !busyUnits.includes(id)));
      return;
    }

    setProcessing(true);
    const toastId = toast.loading(`Dispatching ${selectedUnits.length} unit(s)...`);
    const dispatcherName = getDispatcherName();
    const dispatcherId = user?.personnel_id || user?.uid || 'dispatcher';
    const nowTs = Timestamp.now();
    const nowIso = new Date().toISOString();

    try {
      for (const unitId of selectedUnits) {
        const unit = units.find(u => u.unit_id === unitId);
        if (!unit) continue;
        if (!hasValidCoords(unit)) {
          console.warn(`Skipping ${unitId} — missing valid coords`);
          continue;
        }

        const unitName = unit.unit_name || unitId;
        const unitCode = unit.unit_code || unitId;

        const route = await fetchLiveRoute(
          unit.latitude, unit.longitude,
          selectedIncident.latitude, selectedIncident.longitude
        );

        await updateUnitStatus(unitId, 'Dispatched', selectedIncident.incident_id);

        const dispatchRef = await addDoc(collection(firestore, 'unit_dispatches'), {
          target_unit_id: unitId,
          target_unit_name: unitName,
          target_unit_code: unitCode,

          incident_id: selectedIncident.incident_id,
          latitude: selectedIncident.latitude,
          longitude: selectedIncident.longitude,
          location_address: selectedIncident.location_address || '',
          threat_level: selectedIncident.threat_level || 'RED',
          description: selectedIncident.description || '',
          caller_name: selectedIncident.caller_name || '',
          caller_phone: selectedIncident.caller_phone || '',

          route_distance_km: route.distanceKm,
          route_distance_text: route.distanceText,
          route_eta_minutes: route.etaMinutes,
          route_eta_text: route.etaText,
          route_from_lat: unit.latitude,
          route_from_lng: unit.longitude,

          dispatcher_id: dispatcherId,
          dispatcher_name: dispatcherName,

          dispatched_at: nowTs,
          acknowledged: false,
          acknowledged_at: null,
          acknowledged_by_unit: null,
          acknowledged_by_unit_name: null,
          navigation_started: false,
          navigation_stopped: false,
          cancelled: false,
          completed: false,
          navigation_started_at: null,
          status: 'pending',

          created_at: serverTimestamp(),
          updated_at: nowTs,
        });

        console.log(
          `🚒 [Dispatch] ✅ Wrote unit_dispatches/${dispatchRef.id} ` +
          `${unitName} → ${selectedIncident.incident_id} (${route.distanceText}, ${route.etaText})`
        );

        setUnits(prev => prev.map(u =>
          u.unit_id === unitId
            ? {
              ...u,
              status: 'Dispatched',
              current_incident_id: selectedIncident.incident_id,
            }
            : u
        ));
      }

      await updateIncidentStatus(
        selectedIncident.incident_id,
        'Dispatched',
        user.personnel_id || 'dispatcher',
        selectedIncident.status as IncidentStatus
      );

      setIncidents(prev => prev.map(inc =>
        inc.incident_id === selectedIncident.incident_id
          ? {
            ...inc,
            status: 'Dispatched',
            dispatched_at: nowIso,
          }
          : inc
      ));

      await logActivity('dispatch_units', 'incident', selectedIncident.incident_id);

      toast.success(
        `✅ ${selectedUnits.length} unit(s) dispatched to ${selectedIncident.incident_id}`,
        { id: toastId, duration: 4000 }
      );

      setShowDispatchModal(false);
      setSelectedUnits([]);
      setUnitRoutes({});
    } catch (error) {
      console.error('❌ [Dispatch] Failed:', error);
      toast.error('Failed to dispatch units', { id: toastId, duration: 5000 });
    } finally {
      setProcessing(false);
    }
  };

  useEffect(() => {
    console.log('✅ [OnSceneSync] Bridge listening on unit_dispatches for on-scene updates');

    const q = query(
      collection(firestore, 'unit_dispatches'),
      orderBy('dispatched_at', 'desc'),
      limit(80)
    );

    const unsub = onSnapshot(q, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== 'modified' && change.type !== 'added') return;

        const d = change.doc.data() as any;
        const dispatchStatus = (d.status || '').toLowerCase();
        const isOnScene =
          d.on_scene === true ||
          dispatchStatus === 'on_scene' ||
          dispatchStatus === 'onscene';

        if (!isOnScene) return;

        const unitId = d.target_unit_id;
        const incidentId = d.incident_id;
        if (!unitId || !incidentId) return;

        console.log(
          `📍 [OnSceneSync] Unit ${unitId} is now ON SCENE at incident ${incidentId}`
        );

        setUnits(prev => prev.map(u =>
          u.unit_id === unitId
            ? { ...u, status: 'OnScene', current_incident_id: incidentId }
            : u
        ));

        setIncidents(prev => prev.map(inc =>
          inc.incident_id === incidentId
            ? { ...inc, status: 'OnScene' }
            : inc
        ));

        const unit = unitsRefForWatchdog.current.find(u => u.unit_id === unitId);
        if (unit) {
          toast.success(
            `📍 ${unit.unit_name} arrived at scene — ${incidentId}`,
            { duration: 5000, icon: '📍' }
          );
        }
      });
    }, (err) => {
      console.warn('❌ [OnSceneSync] listener error:', err);
    });

    return () => unsub();
  }, []);

  const handleStopIotAlarm = (): void => {
    if (iotAlarmAudioRef.current) iotAlarmAudioRef.current.pause();
    if (yellowAlarmAudioRef.current) yellowAlarmAudioRef.current.pause();
    stickyRedAlertRef.current = null;
    stickyYellowAlertRef.current = null;
    setIotHighThreatAlarm(false);
    setHighThreatSensor(null);
    setGasSmokeAlarm(false);
    setGasSmokeSensor(null);
    toast.success('IoT alarm acknowledged');
  };

  const resetAllUnitsToAvailable = async (): Promise<void> => {
    if (!units || units.length === 0) {
      toast('No units to reset', { icon: 'ℹ️' });
      return;
    }

    const confirmed = window.confirm(
      `⚠️ Force ALL ${units.length} units back to Available?\n\n` +
      `This will cancel all active dispatches and cannot be undone.`
    );
    if (!confirmed) return;

    setProcessing(true);
    const toastId = toast.loading('Resetting all units...');
    let cancelledCount = 0;

    try {
      try {
        const snap = await getDocs(collection(firestore, 'unit_dispatches'));
        for (const docSnap of snap.docs) {
          const d = docSnap.data() as any;
          const isTerminal =
            d.status === 'completed' ||
            d.status === 'cancelled' ||
            d.status === 'canceled' ||
            d.status === 'resolved' ||
            d.cancelled === true;

          if (!isTerminal) {
            await updateDoc(doc(firestore, 'unit_dispatches', docSnap.id), {
              status: 'cancelled',
              cancelled: true,
              cancelled_at: serverTimestamp(),
              cancelled_by: 'dispatcher_bulk_reset',
              cancel_reason: 'Bulk reset by dispatcher',
            }).catch(() => { });
            cancelledCount++;
          }
        }
      } catch (err) {
        console.warn('Bulk cancel of dispatches partially failed:', err);
      }

      for (const unit of units) {
        try {
          await updateUnitStatus(unit.unit_id, 'Available', null as any);
        } catch (err) {
          console.warn(`Failed to reset ${unit.unit_id}:`, err);
        }
      }

      setUnits(prev => prev.map(u => ({
        ...u,
        status: 'Available' as ResponseUnit['status'],
        current_incident_id: null,
      })));

      toast.success(
        `✅ Reset ${units.length} unit(s) to Available (${cancelledCount} dispatch(es) cancelled)`,
        { id: toastId, duration: 4000 }
      );
    } catch (err) {
      console.error('Reset all units failed:', err);
      toast.error('Failed to reset all units', { id: toastId, duration: 4000 });
    } finally {
      setProcessing(false);
    }
  };

  const handleTabClick = (tabId: 'dashboard' | 'incidents' | 'units' | 'sensors' | 'emergencies') => {
    setActiveSidebarTab(tabId);
    setShowOverlay(true);
  };

  const handleCloseOverlay = () => setShowOverlay(false);

  const handleLogout = async (): Promise<void> => {
    try { await logout(); toast.success('Logged out'); }
    catch { toast.error('Failed to logout'); }
    finally { setShowLogoutConfirm(false); }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!panelRef.current) return;
    setIsDragging(true);
    const rect = panelRef.current.getBoundingClientRect();
    setDragOffset({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    document.body.style.userSelect = 'none';
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;
    const pw = panelRef.current?.offsetWidth || 380;
    const ph = panelRef.current?.offsetHeight || 400;
    setPanelPosition({ x: Math.max(10, Math.min(newX, window.innerWidth - pw - 10)), y: Math.max(10, Math.min(newY, window.innerHeight - ph - 10)) });
  }, [isDragging, dragOffset.x, dragOffset.y]);

  const handleMouseUp = useCallback(() => { setIsDragging(false); document.body.style.userSelect = ''; }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const STALE_DISPATCH_MS = 5 * 60_000;
    const WATCHDOG_INTERVAL_MS = 30_000;

    const watchdog = setInterval(async () => {
      try {
        const stuckUnits = unitsRefForWatchdog.current.filter(
          u => (u.status === 'Dispatched' || u.status === 'EnRoute' || u.status === 'OnScene') && u.current_incident_id
        );
        if (stuckUnits.length === 0) return;

        for (const unit of stuckUnits) {
          const q = query(
            collection(firestore, 'unit_dispatches'),
            where('target_unit_id', '==', unit.unit_id)
          );

          let snap;
          try {
            snap = await getDocs(q);
          } catch (queryErr) {
            console.warn('🧹 [Watchdog] query failed for', unit.unit_id, queryErr);
            continue;
          }

          if (snap.empty) {
            console.log(
              `🧹 [Watchdog] ${unit.unit_name} is ${unit.status} but has no dispatch order → resetting`
            );
            try {
              await updateUnitStatus(unit.unit_id, 'Available', null as any);
            } catch (e) {
              console.warn('updateUnitStatus failed (watchdog empty):', e);
            }
            setUnits(prev => prev.map(u =>
              u.unit_id === unit.unit_id
                ? { ...u, status: 'Available', current_incident_id: null }
                : u
            ));
            continue;
          }

          const sortedDocs = snap.docs.sort((a, b) => {
            const aT = (a.data() as any)?.dispatched_at?.toDate?.().getTime?.() ?? 0;
            const bT = (b.data() as any)?.dispatched_at?.toDate?.().getTime?.() ?? 0;
            return bT - aT;
          });

          const latestDoc = sortedDocs[0];
          const d = latestDoc.data() as any;

          const isTerminal =
            d.status === 'completed' ||
            d.status === 'cancelled' ||
            d.status === 'canceled' ||
            d.status === 'resolved' ||
            d.cancelled === true;

          if (isTerminal) {
            console.log(`🧹 [Watchdog] ${unit.unit_name} latest dispatch is terminal → reset`);
            try {
              await updateUnitStatus(unit.unit_id, 'Available', null as any);
            } catch (e) {
              console.warn('updateUnitStatus failed (watchdog terminal):', e);
            }
            setUnits(prev => prev.map(u =>
              u.unit_id === unit.unit_id
                ? { ...u, status: 'Available', current_incident_id: null }
                : u
            ));
            continue;
          }

          if (d.acknowledged === true || d.navigation_started === true || d.on_scene === true) {
            continue;
          }

          const dispatchedAtMs = d.dispatched_at?.toDate?.().getTime?.() ?? 0;
          const ageMs = dispatchedAtMs > 0 ? Date.now() - dispatchedAtMs : 0;

          if (ageMs > STALE_DISPATCH_MS && d.acknowledged !== true && d.navigation_started !== true) {
            console.warn(
              `⏰ [Watchdog] ${unit.unit_name} order ${latestDoc.id} is stale ` +
              `(${Math.round(ageMs / 1000)}s old, no ACK) → cancelling`
            );

            try {
              await updateDoc(doc(firestore, 'unit_dispatches', latestDoc.id), {
                status: 'cancelled',
                cancelled: true,
                cancelled_at: serverTimestamp(),
                cancelled_by: 'watchdog',
                cancel_reason: 'Unit did not acknowledge within 5 minutes',
              });
            } catch (cancelErr) {
              console.warn('cancel stale dispatch failed:', cancelErr);
            }

            try {
              await updateUnitStatus(unit.unit_id, 'Available', null as any);
            } catch (e) {
              console.warn('updateUnitStatus failed (watchdog stale):', e);
            }

            setUnits(prev => prev.map(u =>
              u.unit_id === unit.unit_id
                ? { ...u, status: 'Available', current_incident_id: null }
                : u
            ));

            toast(
              `⏰ ${unit.unit_name} did not respond — auto-returned to Available`,
              { icon: '⏰', duration: 5000 }
            );
          }
        }
      } catch (err) {
        console.warn('🧹 [Watchdog] error:', err);
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => clearInterval(watchdog);
  }, []);

  const liveAvailableUnits = useMemo(() => {
    const now = Date.now();

    return units.filter(u => {
      if (u.status !== 'Available') return false;
      if (!isValidCoord(u.latitude, u.longitude)) return false;

      const explicitOnline = (u as any).is_online;

      if (explicitOnline === false) return false;

      const lastActive = (u as any).last_active as number | undefined;
      if (typeof lastActive === 'number' && lastActive > 0) {
        return now - lastActive <= HEARTBEAT_TTL_MS;
      }

      if (u.last_update) {
        const lastUpdateMs = new Date(u.last_update).getTime();
        if (!Number.isNaN(lastUpdateMs)) {
          return now - lastUpdateMs <= HEARTBEAT_TTL_MS;
        }
      }

      if (explicitOnline === true) return true;

      return false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, unitTick]);

  useEffect(() => {
    if (!showDispatchModal) return;
    if (!selectedIncident) return;
    if (!hasValidCoords(selectedIncident)) return;
    if (liveAvailableUnits.length === 0) return;

    const incLat = selectedIncident.latitude;
    const incLng = selectedIncident.longitude;

    let cancelled = false;

    const refresh = async () => {
      const next: Record<string, LiveRoute> = { ...unitRoutes };
      for (const u of liveAvailableUnits) {
        if (cancelled) return;
        if (!hasValidCoords(u)) continue;
        const r = await fetchLiveRoute(
          u.latitude, u.longitude,
          incLat, incLng
        );
        next[u.unit_id] = r;
      }
      if (!cancelled) setUnitRoutes(next);
    };

    refresh();
    const interval = setInterval(refresh, 15_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDispatchModal, selectedIncident?.incident_id, liveAvailableUnits.length]);

  const activeIncidents = incidents.filter(
    inc => !isTerminalIncidentStatus(inc.status) && !isHiddenFromDispatcher(inc)
  );
  const availableUnits = liveAvailableUnits;
  const unacknowledgedEmergencies = mobileEmergencies.filter(e => !e.acknowledged);
  const verifiedEmergencies = mobileEmergencies.filter(e => e.verified);

  const redSensors = useMemo(
    () => sensors.filter(s => {
      const cached = stickySensorDataRef.get(s.sensor_id);
      const effectiveThreat = cached && stickySensorPinIdsRef.has(s.sensor_id)
        ? cached.threat_level
        : s.threat_level;
      return effectiveThreat === 'RED' && isSensorLive(s);
    }),
    [sensors]
  );
  const unackedRedSensors = useMemo(
    () => redSensors.filter(s => !s.dispatcher_acknowledged && !s.verified),
    [redSensors]
  );

  const filteredIncidents = useMemo(() => {
    const filtered = incidents
      .filter(inc => !isHiddenFromDispatcher(inc))
      .filter(inc => {
        const normalizedStatus = normalizeIncidentStatus(inc.status);
        if (incidentFilter !== 'all' && normalizedStatus !== incidentFilter) return false;
        if (searchQuery && !inc.incident_id.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !(inc.location_address || '').toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      });

    return [...filtered].sort((a, b) => {
      const aNorm = normalizeIncidentStatus(a.status);
      const bNorm = normalizeIncidentStatus(b.status);
      const aTerminal = isTerminalIncidentStatus(aNorm) ? 1 : 0;
      const bTerminal = isTerminalIncidentStatus(bNorm) ? 1 : 0;

      if (aTerminal !== bTerminal) return bTerminal - aTerminal;

      const aTime = new Date(a.reported_at || 0).getTime();
      const bTime = new Date(b.reported_at || 0).getTime();
      return bTime - aTime;
    });
  }, [incidents, incidentFilter, searchQuery]);

  const filteredUnits = useMemo(() => units.filter(unit => {
    if (unitFilter !== 'all' && unit.status !== unitFilter) return false;
    if (searchQuery && !unit.unit_name.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !unit.unit_code.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  }), [units, unitFilter, searchQuery]);

  const filteredSensors = useMemo(() => sensors
    .map(s => mergeWithStickySnapshot(s))
    .filter(sensor => {
      if (sensorFilter !== 'all' && sensor.threat_level !== sensorFilter) return false;
      if (searchQuery && !sensor.sensor_id.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !sensor.location.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    }), [sensors, sensorFilter, searchQuery]);

  const visibleIncidents = useMemo(
    () => incidents.filter(
      inc =>
        !isTerminalIncidentStatus(inc.status) &&
        !resolvedIncidentIdsRef.current.has(inc.incident_id) &&
        !isHiddenFromDispatcher(inc) &&
        hasValidCoords(inc)
    ),
    [incidents]
  );

  const visibleMobileEmergencies = useMemo(() => {
    const terminalIncidentIds = new Set(
      incidents
        .filter(inc => isTerminalIncidentStatus(inc.status))
        .map(inc => inc.incident_id)
    );

    return mobileEmergencies.filter(emergency => {
      if (!hasValidCoords(emergency)) return false;
      if (emergency.resolved === true) return false;
      if (emergency.marker_visible === false) return false;

      if (resolvedEmergencyIdsRef.current.has(emergency.id)) return false;
      if (emergency.callId && resolvedEmergencyIdsRef.current.has(emergency.callId)) return false;

      if (emergency.incident_id && terminalIncidentIds.has(emergency.incident_id)) {
        return false;
      }

      const s = (emergency.status || '').toLowerCase();
      if (s === 'resolved' || s === 'cancelled' || s === 'canceled') return false;

      return true;
    });
  }, [mobileEmergencies, incidents]);

  const mapUnits = useMemo(() => {
    return units
      .filter(u => hasValidCoords(u) && isUnitOnline(u))
      .map(u => {
        const latest = latestDispatchByUnit.get(u.unit_id);
        const derived = latest && !latest.isTerminal
          ? {
            ...u,
            status: latest.derivedStatus,
            current_incident_id: latest.incidentId,
          }
          : u;
        return derived as ResponseUnit;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, unitTick, latestDispatchByUnit]);

  const mapUnitsWithActiveDispatch = useMemo(() => {
    return units
      .filter(u => {
        if (!hasValidCoords(u) || !isUnitOnline(u)) return false;

        const latest = latestDispatchByUnit.get(u.unit_id);

        if (!latest) return false;
        if (latest.isTerminal) return false;
        if (!latest.incidentId) return false;
        if (u.status === 'Available' && !u.current_incident_id) return false;

        return true;
      })
      .map(u => {
        const latest = latestDispatchByUnit.get(u.unit_id)!;
        return {
          ...u,
          status: latest.derivedStatus,
          current_incident_id: latest.incidentId,
        } as ResponseUnit;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, unitTick, latestDispatchByUnit]);

  const mapSensors = useMemo(
    () =>
      sensors
        .map(s => mergeWithStickySnapshot(s))
        .filter(
          (s) =>
            hasValidCoords(s) &&
            isSensorVisibleOnDispatcherMap(s)
        ),
    [sensors]
  );

  const onlineUnitStatuses = useMemo(() => {
    const statuses = new Set<string>();

    mapUnitsWithActiveDispatch.forEach(u => {
      if (u.status !== 'Available') {
        statuses.add(u.status);
      }
    });

    return statuses;
  }, [mapUnitsWithActiveDispatch]);

  const stats = {
    totalIncidents: incidents.filter(i => !isHiddenFromDispatcher(i)).length,
    activeIncidents: activeIncidents.length,
    resolvedIncidents: incidents.filter(
      i => normalizeIncidentStatus(i.status) === 'Resolved' && !isHiddenFromDispatcher(i)
    ).length,
    cancelledIncidents: incidents.filter(
      i => normalizeIncidentStatus(i.status) === 'Cancelled' && !isHiddenFromDispatcher(i)
    ).length,
    availableUnits: availableUnits.length,
    dispatchedUnits: units.filter(u => u.status === 'Dispatched').length,
    enRouteUnits: units.filter(u => u.status === 'EnRoute').length,
    onSceneUnits: units.filter(u => u.status === 'OnScene').length,
    onlineUnits: mapUnits.length,
    activeSensors: sensors.filter(s => s.status === 'Active').length,
    highThreatSensors: redSensors.length,
    yellowThreatSensors: sensors
      .map(s => mergeWithStickySnapshot(s))
      .filter(s => s.threat_level === 'YELLOW' && isSensorVisibleOnDispatcherMap(s)).length,
    mobileEmergencies: mobileEmergencies.length,
    unacknowledgedEmergencies: unacknowledgedEmergencies.length,
    verifiedEmergencies: verifiedEmergencies.length,
  };

  const getStatusColor = (status: string) => {
    const normalized = normalizeIncidentStatus(status);
    const colors: Record<string, string> = {
      Received: '#6c757d', Verified: '#17a2b8', Dispatched: '#007bff',
      EnRoute: '#fd7e14', OnScene: '#dc3545', Resolved: '#28a745',
      Cancelled: '#6c757d', Available: '#28a745', OffDuty: '#6c757d',
      Acknowledged: '#28a745', Connected: '#28a745',
    };
    return colors[normalized] || '#6c757d';
  };

  const sidebarNavItems = useMemo(() => [
    { id: 'dashboard', icon: FaTachometerAlt, label: 'DASHBOARD', description: '', color: '#17a2b8', badge: null },
    { id: 'emergencies', icon: FaPhoneAlt, label: 'EMERGENCIES', description: '', color: '#dc3545', badge: unacknowledgedEmergencies.length },
    { id: 'incidents', icon: FaFire, label: 'INCIDENTS', description: '', color: '#dc3545', badge: activeIncidents.length },
    { id: 'units', icon: FaTruck, label: 'RESPONSE UNITS', description: '', color: '#28a745', badge: availableUnits.length },
    { id: 'sensors', icon: FaSatelliteDish, label: 'IoT SENSORS', description: '', color: '#ffc107', badge: unackedRedSensors.length },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [unacknowledgedEmergencies.length, activeIncidents.length, availableUnits.length, unackedRedSensors.length]);

  useEffect(() => {
    const next: { [k: string]: number } = {
      emergencies: unacknowledgedEmergencies.length,
      incidents: activeIncidents.length,
      units: availableUnits.length,
      sensors: unackedRedSensors.length,
    };
    let bumped = false;
    for (const k of Object.keys(next)) {
      const prev = prevBadgeCountsRef.current[k] ?? 0;
      if (next[k] > prev) bumped = true;
    }
    prevBadgeCountsRef.current = next;
    if (bumped) setBadgePulseKey(p => p + 1);
  }, [
    unacknowledgedEmergencies.length,
    activeIncidents.length,
    availableUnits.length,
    unackedRedSensors.length,
  ]);

  const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
  const hasApiKey = Boolean(googleMapsApiKey);

  const safeSelectedMarker =
    selectedMarker &&
      selectedMarker.data &&
      hasValidCoords(selectedMarker.data)
      ? selectedMarker
      : null;

  useEffect(() => {
    const gmaps = window.google?.maps;
    const map = mapRef.current;
    if (!gmaps || !map || !mapLoaded) return;

    const markers = imperativeUnitMarkersRef.current;
    const targets = imperativeUnitTargetPosRef.current;

    const activeIds = new Set(mapUnitsWithActiveDispatch.map(u => u.unit_id));

    markers.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        marker.setMap(null);
        markers.delete(id);
        targets.delete(id);
        console.log(`🚒 [Marker] Removed truck for ${id} (no active dispatch)`);
      }
    });

    mapUnitsWithActiveDispatch.forEach(u => {
      const target = { lat: u.latitude, lng: u.longitude };
      targets.set(u.unit_id, target);

      let marker = markers.get(u.unit_id);
      if (!marker) {
        marker = new gmaps.Marker({
          position: target,
          map,
          icon: getUnitIcon(u.status),
          title: u.unit_name,
        });
        marker.addListener('click', () => {
          const live = unitsRefForWatchdog.current.find(x => x.unit_id === u.unit_id);
          if (live) setSelectedMarker({ type: 'unit', data: live });
        });
        markers.set(u.unit_id, marker);
        console.log(`🚒 [Marker] Drew truck for ${u.unit_name} (${u.status})`);
      } else {
        marker.setIcon(getUnitIcon(u.status));
        marker.setTitle(u.unit_name);
      }
    });

    const step = () => {
      let stillAnimating = false;

      markers.forEach((marker, id) => {
        const target = targets.get(id);
        if (!target) return;
        const cur = marker.getPosition();
        if (!cur) return;

        const dLat = target.lat - cur.lat();
        const dLng = target.lng - cur.lng();
        const dist = Math.sqrt(dLat * dLat + dLng * dLng);

        if (dist < 0.000001) {
          marker.setPosition(target);
          return;
        }

        stillAnimating = true;
        const nextLat = cur.lat() + dLat * 0.08;
        const nextLng = cur.lng() + dLng * 0.08;
        marker.setPosition({ lat: nextLat, lng: nextLng });
      });

      if (stillAnimating) {
        imperativeUnitAnimFrameRef.current = requestAnimationFrame(step);
      } else {
        imperativeUnitAnimFrameRef.current = null;
      }
    };

    if (imperativeUnitAnimFrameRef.current === null) {
      imperativeUnitAnimFrameRef.current = requestAnimationFrame(step);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapUnitsWithActiveDispatch, mapLoaded]);

  useEffect(() => {
    const markers = imperativeUnitMarkersRef.current;
    const targets = imperativeUnitTargetPosRef.current;

    markers.forEach((marker, unitId) => {
      const latest = latestDispatchByUnit.get(unitId);
      const isNowTerminal = !latest || latest.isTerminal || !latest.incidentId;

      if (isNowTerminal) {
        marker.setMap(null);
        markers.delete(unitId);
        targets.delete(unitId);
        console.log(`🚒 [Marker] Force-removed truck for ${unitId} (dispatch terminal)`);
      }
    });
  }, [latestDispatchByUnit]);

  useEffect(() => {
    const gmaps = window.google?.maps;
    const map = mapRef.current;
    if (!gmaps || !map || !mapLoaded) return;

    const halos = imperativeUnitHalosRef.current;

    const activeHaloUnits = mapUnitsWithActiveDispatch.filter(
      (u) => u.status === 'EnRoute' && hasValidCoords(u)
    );

    const activeIds = new Set(activeHaloUnits.map((u) => u.unit_id));

    halos.forEach((circle, unitId) => {
      if (!activeIds.has(unitId)) {
        try {
          circle.setMap(null);
        } catch {
          /* ignore */
        }
        halos.delete(unitId);
        console.log(`🧹 [Halo] Removed EnRoute halo for ${unitId}`);
      }
    });

    activeHaloUnits.forEach((u) => {
      const center = { lat: u.latitude, lng: u.longitude };
      let circle = halos.get(u.unit_id);

      if (!circle) {
        circle = new gmaps.Circle({
          center,
          radius: 60,
          map,
          fillColor: '#17a2b8',
          fillOpacity: 0.12,
          strokeColor: '#17a2b8',
          strokeOpacity: 0.7,
          strokeWeight: 2,
          zIndex: 4,
        });
        halos.set(u.unit_id, circle);
        console.log(`🔵 [Halo] Drew EnRoute halo for ${u.unit_name || u.unit_id}`);
      } else {
        circle.setCenter(center);
        circle.setMap(map);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapUnitsWithActiveDispatch, mapLoaded]);

  useEffect(() => {
    const halos = imperativeUnitHalosRef.current;
    halos.forEach((circle, unitId) => {
      const latest = latestDispatchByUnit.get(unitId);
      const isNowTerminal = !latest || latest.isTerminal || !latest.incidentId;
      if (isNowTerminal) {
        try {
          circle.setMap(null);
        } catch {
          /* ignore */
        }
        halos.delete(unitId);
        console.log(`🧹 [Halo] Force-removed halo for ${unitId} (dispatch terminal)`);
      }
    });
  }, [latestDispatchByUnit]);

  useEffect(() => {
    return () => {
      imperativeUnitMarkersRef.current.forEach(m => { try { m.setMap(null); } catch { /* ignore */ } });
      imperativeUnitMarkersRef.current.clear();
      imperativeUnitTargetPosRef.current.clear();

      imperativeUnitHalosRef.current.forEach(c => { try { c.setMap(null); } catch { /* ignore */ } });
      imperativeUnitHalosRef.current.clear();

      if (imperativeUnitAnimFrameRef.current !== null) {
        cancelAnimationFrame(imperativeUnitAnimFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const gmaps = window.google?.maps;
    const map = mapRef.current;
    if (!gmaps || !map || !mapLoaded) return;

    const activeUnitRoutes = mapUnitsWithActiveDispatch
      .filter(u => {
        const latest = latestDispatchByUnit.get(u.unit_id);
        if (!latest || latest.isTerminal) return false;
        if (!latest.incidentId) return false;
        if (u.status === 'Available') return false;
        return hasValidCoords(u);
      })
      .map(u => {
        const latest = latestDispatchByUnit.get(u.unit_id)!;
        const incident = incidents.find(i => i.incident_id === latest.incidentId);
        return { unit: u, incident, dispatch: latest };
      })
      .filter(x => x.incident && hasValidCoords(x.incident));

    const activeUnitIds = new Set(activeUnitRoutes.map(x => x.unit.unit_id));

    liveDispatchPolylinesRef.current.forEach((polyline, unitId) => {
      if (!activeUnitIds.has(unitId)) {
        try { polyline.setMap(null); } catch { /* ignore */ }
        liveDispatchPolylinesRef.current.delete(unitId);
        liveDispatchRouteKeysRef.current.delete(unitId);
        liveDispatchRouteDataRef.current.delete(unitId);
        console.log(`🧹 [LiveRoute] Removed polyline for inactive unit ${unitId}`);
      }
    });

    if (activeUnitRoutes.length === 0) return;

    let cancelled = false;

    const updateRoutes = async () => {
      for (const { unit, incident } of activeUnitRoutes) {
        if (cancelled) return;

        const prevKey = liveDispatchRouteKeysRef.current.get(unit.unit_id) || '';
        const nextKey = `${unit.latitude.toFixed(5)},${unit.longitude.toFixed(5)}>${incident!.latitude.toFixed(5)},${incident!.longitude.toFixed(5)}`;

        const [prevLatStr, prevLngStr] = prevKey.split('>')[0]?.split(',') || [];
        const prevLat = parseFloat(prevLatStr);
        const prevLng = parseFloat(prevLngStr);
        const movedEnough =
          !Number.isFinite(prevLat) ||
          calculateDistance(prevLat, prevLng, unit.latitude, unit.longitude) > 0.025;

        const cachedRoute = liveDispatchRouteDataRef.current.get(unit.unit_id);
        const cacheExpired =
          !cachedRoute ||
          Date.now() - (cachedRoute.__fetchedAt || 0) > 15_000;

        if (!movedEnough && !cacheExpired) continue;

        try {
          const url = `${OSRM_API_BASE}/route/v1/driving/${unit.longitude},${unit.latitude};${incident!.longitude},${incident!.latitude}?overview=full&geometries=geojson&steps=false`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`OSRM ${res.status}`);
          const data = await res.json();
          if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route');

          const r = data.routes[0];
          const coords: Array<{ lat: number; lng: number }> = r.geometry.coordinates.map(
            (c: number[]) => ({ lat: c[1], lng: c[0] })
          );

          const routeObj: OSRMRouteData = {
            route: coords,
            distance: r.distance,
            duration: r.duration,
            distance_text: r.distance < 1000
              ? `${Math.round(r.distance)} m`
              : `${(r.distance / 1000).toFixed(2)} km`,
            duration_text: r.duration < 60
              ? `${Math.round(r.duration)} sec`
              : `${Math.round(r.duration / 60)} min`,
            __fetchedAt: Date.now(),
          };

          if (cancelled) return;

          liveDispatchRouteDataRef.current.set(unit.unit_id, routeObj);
          liveDispatchRouteKeysRef.current.set(unit.unit_id, nextKey);

          const path = coords.map(p => ({ lat: p.lat, lng: p.lng }));
          let polyline = liveDispatchPolylinesRef.current.get(unit.unit_id);

          const statusColor =
            unit.status === 'Dispatched' ? '#007bff' :
              unit.status === 'EnRoute' ? '#17a2b8' :
                unit.status === 'OnScene' ? '#fd7e14' : '#0d6efd';

          if (!polyline) {
            polyline = new gmaps.Polyline({
              path,
              strokeColor: statusColor,
              strokeWeight: 4,
              strokeOpacity: 0.75,
              geodesic: true,
              zIndex: 5,
              map,
            });
            liveDispatchPolylinesRef.current.set(unit.unit_id, polyline);
            console.log(
              `🛣️ [LiveRoute] Drew polyline for ${unit.unit_name || unit.unit_id} → ${incident!.incident_id} ` +
              `(${routeObj.distance_text}, ${routeObj.duration_text})`
            );
          } else {
            polyline.setPath(path);
            polyline.setOptions({ strokeColor: statusColor });
            console.log(
              `🛣️ [LiveRoute] Updated polyline for ${unit.unit_name || unit.unit_id} ` +
              `(${routeObj.distance_text} remaining)`
            );
          }
        } catch (err) {
          console.warn(`🛣️ [LiveRoute] Failed to fetch route for ${unit.unit_id}:`, err);
        }
      }
    };

    updateRoutes();
    const interval = setInterval(updateRoutes, 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapUnitsWithActiveDispatch, latestDispatchByUnit, incidents, mapLoaded]);

  useEffect(() => {
    return () => {
      liveDispatchPolylinesRef.current.forEach(polyline => {
        try { polyline.setMap(null); } catch { /* ignore */ }
      });
      liveDispatchPolylinesRef.current.clear();
      liveDispatchRouteKeysRef.current.clear();
      liveDispatchRouteDataRef.current.clear();
    };
  }, []);

  return (
    <div ref={containerRef} className="dispatcher-geomap" style={{ height: '100vh', overflow: 'hidden', position: 'relative', backgroundColor: '#0d0d1a' }}>

      <audio
        ref={remoteAudioRef}
        autoPlay
        playsInline
        controls={false}
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          opacity: 0,
          pointerEvents: 'none',
          top: 0,
          left: 0,
        }}
        onLoadedMetadata={() => {
          console.log('🔊 [WebRTC] Audio metadata loaded, attempting play');
          const audio = remoteAudioRef.current;
          if (audio) {
            audio.volume = 1.0;
            audio.muted = false;
            audio.play().catch(err => {
              console.warn('🔇 [WebRTC] Play blocked on metadata:', err.message);
            });
          }
        }}
        onCanPlay={() => {
          console.log('🔊 [WebRTC] Audio can play, forcing play');
          const audio = remoteAudioRef.current;
          if (audio) {
            audio.volume = 1.0;
            audio.muted = false;
            audio.play().catch(err => {
              console.warn('🔇 [WebRTC] Play blocked on canplay:', err.message);
            });
          }
        }}
      />

      {showIncomingCall && incomingCall && hasValidCoords(incomingCall) && (
        <IncomingCallOverlay
          emergency={incomingCall}
          onAcknowledge={handleIncomingCallAcknowledge}
          onDismiss={handleIncomingCallDismiss}
          onEndCall={handleEndCall}
          dispatcherName={getDispatcherName()}
          dispatcherRole={getDispatcherRole()}
          isCallConnected={isCallConnected}
        />
      )}

      {callState.isActive && !showIncomingCall && (
        <ActiveCallOverlay
          callerName={callState.callerName || incomingCall?.caller_name || 'Unknown Caller'}
          callerPhone={callState.callerPhone || incomingCall?.caller_phone || ''}
          callDuration={callState.callDuration}
          isMuted={callState.isMuted}
          isSpeakerOn={callState.isSpeakerOn}
          isConnected={callState.isConnected}
          onEndCall={handleEndCall}
          onToggleMute={toggleMute}
          onToggleSpeaker={toggleSpeaker}
        />
      )}

      {showFireAlarm && <FireAlarm onSilence={handleStopAlarm} autoStart={false} />}

      {/* HEADER */}
      <header style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: '56px',
        backgroundColor: 'rgba(13, 13, 26, 0.95)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.08)', zIndex: 2000,
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: '16px',
        boxShadow: '0 2px 20px rgba(0,0,0,0.4)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <div style={{ width: '32px', height: '32px', borderRadius: '8px', backgroundColor: 'rgba(220,53,69,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '10px' }}>
            <FaFire className="text-danger" size={16} />
          </div>
          <span style={{ color: '#ffffff', fontWeight: '700', fontSize: '16px', letterSpacing: '0.5px' }}>EmberNet</span>
          <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', fontWeight: '500', marginLeft: '8px' }}>| DISPATCH</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              backgroundColor: wsConnected ? '#28a745' : '#dc3545', marginRight: '8px',
              animation: wsConnected ? 'pulse 2s infinite' : 'none'
            }} />
            <span style={{ color: wsConnected ? 'rgba(255,255,255,0.8)' : '#ff6b6b', fontSize: '12px', fontWeight: '700', letterSpacing: '1px' }}>
              {wsConnected ? 'LIVE' : (wsReconnecting ? 'RECONNECTING...' : 'OFFLINE')}
            </span>
          </div>

          {callState.isActive && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              backgroundColor: 'rgba(40,167,69,0.2)', padding: '6px 18px',
              borderRadius: '20px', border: '2px solid rgba(40,167,69,0.4)', flexShrink: 0
            }}>
              <FaMicrophone size={14} style={{ color: '#4dff88' }} />
              <span style={{ color: '#4dff88', fontSize: '13px', fontWeight: '700' }}>
                CALL ACTIVE — {formatCallDuration(callState.callDuration)}
              </span>
            </div>
          )}

          {stats.unacknowledgedEmergencies > 0 && !callState.isActive && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              backgroundColor: 'rgba(220,53,69,0.2)', padding: '6px 18px',
              borderRadius: '20px', border: '2px solid rgba(220,53,69,0.4)',
              animation: 'pulse-glow-fast 1.5s infinite', flexShrink: 0
            }}>
              <FaPhoneAlt size={14} className="text-danger" />
              <span style={{ color: '#ff6b6b', fontSize: '13px', fontWeight: '700' }}>
                {stats.unacknowledgedEmergencies} INCOMING CALL{stats.unacknowledgedEmergencies > 1 ? 'S' : ''}
              </span>
            </div>
          )}

          {unackedRedSensors.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              backgroundColor: 'rgba(220,53,69,0.25)', padding: '6px 18px',
              borderRadius: '20px', border: '2px solid rgba(220,53,69,0.5)',
              animation: 'pulse-glow-fast 1s infinite', flexShrink: 0
            }}>
              <FaFire size={14} style={{ color: '#ff6b6b' }} />
              <span style={{ color: '#ff6b6b', fontSize: '13px', fontWeight: '700' }}>
                {unackedRedSensors.length} SENSOR FIRE{unackedRedSensors.length > 1 ? 'S' : ''}
              </span>
            </div>
          )}

          {stats.verifiedEmergencies > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              backgroundColor: 'rgba(23,162,184,0.2)', padding: '6px 18px',
              borderRadius: '20px', border: '2px solid rgba(23,162,184,0.4)', flexShrink: 0
            }}>
              <FaShieldAlt size={14} style={{ color: '#4dd0e1' }} />
              <span style={{ color: '#4dd0e1', fontSize: '13px', fontWeight: '700' }}>
                {stats.verifiedEmergencies} VERIFIED
              </span>
            </div>
          )}

          {mapSensors.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              backgroundColor: 'rgba(40,167,69,0.15)', padding: '6px 18px',
              borderRadius: '20px', border: '1px solid rgba(40,167,69,0.3)', flexShrink: 0
            }}>
              <FaSatelliteDish size={13} style={{ color: '#4dff88' }} />
              <span style={{ color: '#4dff88', fontSize: '12px', fontWeight: '700' }}>
                {mapSensors.length} SENSOR{mapSensors.length !== 1 ? 'S' : ''} LIVE
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            color: 'rgba(255,255,255,0.85)', fontSize: '14px', fontWeight: '600',
            fontVariantNumeric: 'tabular-nums',
            backgroundColor: 'rgba(255,255,255,0.06)', padding: '4px 14px',
            borderRadius: '20px', border: '1px solid rgba(255,255,255,0.08)'
          }}>
            <FaClockIcon size={14} style={{ color: 'rgba(255,255,255,0.6)' }} />
            <span>{currentTime || '--:--:--'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: 'rgba(23,162,184,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <FaUser size={12} className="text-info" />
            </div>
            <span style={{ color: '#ffffff', fontSize: '13px', fontWeight: '600' }}>{getDispatcherName()}</span>
          </div>
        </div>
      </header>

      {/* CENTERED: FIRE (RED) ALERT — sticky */}
      {iotHighThreatAlarm && highThreatSensor && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9997,
          width: '90%',
          maxWidth: '560px',
          pointerEvents: 'auto',
        }}>
          <Alert variant="danger" style={{
            borderRadius: '16px',
            marginBottom: 0,
            padding: '22px 28px',
            fontWeight: '600',
            fontSize: '14px',
            background: 'linear-gradient(135deg, rgba(200,35,51,0.98), rgba(140,15,35,0.98))',
            border: '2px solid rgba(255,255,255,0.18)',
            color: '#fff',
            boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 60px rgba(220,53,69,0.5)',
            animation: 'pulse-glow-fast 0.8s infinite'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' }}>
              <div style={{
                width: '52px', height: '52px', borderRadius: '14px',
                background: 'rgba(255,255,255,0.15)',
                border: '2px solid rgba(255,255,255,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                animation: 'alarm-icon-pulse 1s ease-in-out infinite',
              }}>
                <FaExclamationTriangle size={24} style={{ color: '#fff' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '18px', fontWeight: '800', letterSpacing: '0.4px', marginBottom: '4px' }}>
                  🔥 CRITICAL HIGH THREAT DETECTED
                </div>
                <div style={{ fontSize: '13px', fontWeight: '500', opacity: 0.95 }}>
                  Sensor: <strong>{highThreatSensor.sensor_id}</strong>
                  {highThreatSensor.location_name
                    ? ` — ${highThreatSensor.location_name}`
                    : ` — ${highThreatSensor.location}`}
                </div>
                {(() => {
                  const liveDoc = sensors.find(s => s.sensor_id === highThreatSensor.sensor_id);
                  const isLive = liveDoc ? isSensorLive(liveDoc) : false;
                  return !isLive ? (
                    <div style={{
                      fontSize: '11px', fontWeight: '700', marginTop: '6px',
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      background: 'rgba(0,0,0,0.3)', padding: '3px 10px',
                      borderRadius: '10px', border: '1px solid rgba(255,255,255,0.2)'
                    }}>
                      <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        backgroundColor: '#ffc107', display: 'inline-block'
                      }} />
                      SENSOR OFFLINE — PIN STICKY
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  setSelectedSensor(highThreatSensor);
                  setShowSensorModal(true);
                }}
                style={{
                  flex: 1, minWidth: '140px',
                  background: 'rgba(255,255,255,0.2)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  color: '#fff', padding: '10px 18px', borderRadius: '10px',
                  fontSize: '13px', fontWeight: '700', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <FaFire size={13} /> View Sensor
              </button>
              <button
                onClick={() => acknowledgeSensor(highThreatSensor)}
                style={{
                  flex: 1, minWidth: '140px',
                  background: 'rgba(255,255,255,0.95)',
                  border: 'none',
                  color: '#c82333', padding: '10px 18px', borderRadius: '10px',
                  fontSize: '13px', fontWeight: '700', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <FaCheck size={13} /> Acknowledge
              </button>
            </div>
          </Alert>
        </div>
      )}

      {/* CENTERED: GAS / SMOKE (YELLOW) ALERT — STICKY */}
      {gasSmokeAlarm && gasSmokeSensor && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9996,
          width: '90%',
          maxWidth: '520px',
          pointerEvents: 'auto',
        }}>
          <div style={{
            borderRadius: '16px',
            background: 'linear-gradient(135deg, rgba(255,193,7,0.98), rgba(214,150,0,0.98))',
            border: '2px solid rgba(255,255,255,0.25)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 60px rgba(255,193,7,0.5)',
            padding: '22px 28px',
            animation: 'pulse-glow-yellow 1.2s infinite',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' }}>
              <div style={{
                width: '52px', height: '52px', borderRadius: '14px',
                background: 'rgba(0,0,0,0.15)',
                border: '2px solid rgba(0,0,0,0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
                animation: 'alarm-icon-pulse 1s ease-in-out infinite',
              }}>
                <FaExclamationTriangle size={24} style={{ color: '#1a1a2e' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '18px', fontWeight: '800', letterSpacing: '0.4px', marginBottom: '4px', color: '#1a1a2e' }}>
                  ⚠️ GAS / SMOKE DETECTED
                </div>
                <div style={{ fontSize: '13px', fontWeight: '600', color: 'rgba(26,26,46,0.85)' }}>
                  Sensor: <strong>{gasSmokeSensor.sensor_id}</strong>
                  {gasSmokeSensor.location_name
                    ? ` — ${gasSmokeSensor.location_name}`
                    : ` — ${gasSmokeSensor.location}`}
                </div>
                {(() => {
                  const liveDoc = sensors.find(s => s.sensor_id === gasSmokeSensor.sensor_id);
                  const isLive = liveDoc ? isSensorLive(liveDoc) : false;
                  return !isLive ? (
                    <div style={{
                      fontSize: '11px', fontWeight: '700', marginTop: '6px',
                      display: 'inline-flex', alignItems: 'center', gap: '6px',
                      background: 'rgba(0,0,0,0.2)', padding: '3px 10px',
                      borderRadius: '10px', border: '1px solid rgba(0,0,0,0.15)',
                      color: '#1a1a2e'
                    }}>
                      <span style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        backgroundColor: '#1a1a2e', display: 'inline-block'
                      }} />
                      SENSOR OFFLINE — PIN STICKY
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                onClick={() => {
                  setSelectedSensor(gasSmokeSensor);
                  setShowSensorModal(true);
                }}
                style={{
                  flex: 1, minWidth: '110px',
                  background: 'rgba(0,0,0,0.2)',
                  border: '1px solid rgba(0,0,0,0.25)',
                  color: '#fff', padding: '10px 18px', borderRadius: '10px',
                  fontSize: '13px', fontWeight: '700', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <FaSatelliteDish size={13} /> View Sensor
              </button>
              <button
                onClick={() => verifySensorAndCreateIncident(gasSmokeSensor)}
                disabled={processing}
                style={{
                  flex: 1, minWidth: '110px',
                  background: 'rgba(0,0,0,0.85)',
                  border: 'none',
                  color: '#ffc107', padding: '10px 18px', borderRadius: '10px',
                  fontSize: '13px', fontWeight: '700',
                  cursor: processing ? 'default' : 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                {processing ? <FaSpinner className="spin" size={13} /> : <FaShieldAlt size={13} />}
                Verify
              </button>
              <button
                onClick={() => acknowledgeSensor(gasSmokeSensor)}
                style={{
                  flex: 1, minWidth: '110px',
                  background: 'rgba(0,0,0,0.6)',
                  border: '1px solid rgba(0,0,0,0.3)',
                  color: '#fff', padding: '10px 18px', borderRadius: '10px',
                  fontSize: '13px', fontWeight: '700', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                }}
              >
                <FaCheck size={13} /> Acknowledge
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STATION ALARM BANNER */}
      {(alarmTriggered || showFireAlarm) && (
        <div style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9998,
          width: '90%',
          maxWidth: '580px',
          pointerEvents: 'auto',
        }}>
          <div style={{
            borderRadius: '20px',
            overflow: 'hidden',
            boxShadow: '0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08), 0 0 60px rgba(220,53,69,0.3)',
            animation: 'station-alarm-pulse 1.5s ease-in-out infinite',
          }}>
            <div style={{
              background: 'linear-gradient(135deg, #dc3545 0%, #b02a37 50%, #a71d2a 100%)',
              padding: '12px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: '1px solid rgba(255,255,255,0.15)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  backgroundColor: '#fff',
                  display: 'inline-block',
                  animation: 'alarm-dot-blink 0.6s ease-in-out infinite',
                  boxShadow: '0 0 12px rgba(255,255,255,0.8)',
                }} />
                <span style={{
                  color: '#fff',
                  fontSize: '13px',
                  fontWeight: '700',
                  letterSpacing: '2px',
                  textTransform: 'uppercase',
                }}>
                  Emergency Alert
                </span>
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                background: 'rgba(0,0,0,0.25)',
                padding: '4px 14px',
                borderRadius: '20px',
                border: '1px solid rgba(255,255,255,0.2)',
              }}>
                <span style={{
                  color: 'rgba(255,255,255,0.95)',
                  fontSize: '11px',
                  fontWeight: '700',
                  letterSpacing: '1px',
                }}>
                  {currentTime || '--:--:--'}
                </span>
              </div>
            </div>

            <div style={{
              background: 'linear-gradient(180deg, #1a1a2e 0%, #12121f 100%)',
              padding: '28px 32px 24px',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '18px',
                marginBottom: '20px',
              }}>
                <div style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '16px',
                  background: 'linear-gradient(135deg, rgba(220,53,69,0.25), rgba(220,53,69,0.1))',
                  border: '2px solid rgba(220,53,69,0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  animation: 'alarm-icon-pulse 1s ease-in-out infinite',
                }}>
                  <FaBullhorn size={28} style={{ color: '#ff6b6b' }} />
                </div>
                <div>
                  <div style={{
                    fontSize: '22px',
                    fontWeight: '800',
                    color: '#fff',
                    letterSpacing: '0.5px',
                    lineHeight: '1.2',
                    marginBottom: '4px',
                  }}>
                    Station Alarm Activated
                  </div>
                  <div style={{
                    fontSize: '14px',
                    color: 'rgba(255,255,255,0.65)',
                    fontWeight: '500',
                    letterSpacing: '0.3px',
                  }}>
                    Fire station alarm is currently sounding
                  </div>
                </div>
              </div>

              <div style={{
                background: 'rgba(220,53,69,0.08)',
                borderRadius: '12px',
                padding: '16px 20px',
                marginBottom: '20px',
                border: '1px solid rgba(220,53,69,0.2)',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                }}>
                  <FaInfoCircle size={16} style={{ color: '#ffc107', marginTop: '2px', flexShrink: 0 }} />
                  <div style={{
                    fontSize: '13px',
                    color: 'rgba(255,255,255,0.85)',
                    lineHeight: '1.6',
                    fontWeight: '500',
                  }}>
                    <strong style={{ color: '#fff' }}>All personnel respond immediately.</strong>
                    {' '}Proceed to the apparatus bay and await further instructions from the dispatcher.
                  </div>
                </div>
              </div>

              <button
                onClick={handleStopAlarm}
                style={{
                  width: '100%',
                  padding: '14px 24px',
                  borderRadius: '12px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1.5px solid rgba(255,255,255,0.15)',
                  color: '#fff',
                  fontSize: '15px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  transition: 'all 0.2s ease',
                  letterSpacing: '0.3px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)';
                }}
              >
                <FaVolumeMute size={16} />
                Silence Alarm
              </button>
            </div>

            <div style={{
              background: 'rgba(0,0,0,0.4)',
              padding: '10px 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderTop: '1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{
                fontSize: '11px',
                color: 'rgba(255,255,255,0.5)',
                fontWeight: '600',
                letterSpacing: '0.5px',
              }}>
                ⚠️ ACTIVE EMERGENCY CONDITION
              </span>
              <span style={{
                fontSize: '11px',
                color: 'rgba(255,255,255,0.4)',
                fontWeight: '500',
              }}>
                Gonzaga Fire Station (BFP)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* LEFT TOOLBAR */}
      <nav style={{
        position: 'fixed', left: '16px', top: '50%', transform: 'translateY(-50%)',
        zIndex: 1000, display: 'flex', flexDirection: 'column', gap: '6px',
        padding: '8px', borderRadius: '14px',
        backgroundColor: 'rgba(13,13,26,0.85)', backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255,255,255,0.06)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)'
      }}>
        <button onClick={() => setShowSidebar(!showSidebar)} style={{
          width: '44px', height: '44px', borderRadius: '10px',
          background: showSidebar ? 'linear-gradient(135deg, #0d6efd, #0a58ca)' : 'rgba(26,26,46,0.9)',
          border: '1px solid rgba(255,255,255,0.1)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)', cursor: 'pointer', transition: 'all 0.2s ease'
        }} title={showSidebar ? "Close Menu" : "Open Menu"}>
          {showSidebar ? <FaTimesCircle size={18} /> : <FaBars size={18} />}
        </button>

        <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '2px 4px' }} />

        {[
          { icon: <FaPlus size={16} />, action: handleZoomIn, title: 'Zoom In' },
          { icon: <FaMinus size={16} />, action: handleZoomOut, title: 'Zoom Out' },
          { icon: <FaHome size={16} />, action: handleResetView, title: 'Reset View' },
          { icon: isFullscreen ? <FaCompress size={16} /> : <FaExpand size={16} />, action: toggleFullscreen, title: isFullscreen ? 'Exit Fullscreen' : 'Fullscreen' },
        ].map((btn, idx) => (
          <button key={idx} onClick={btn.action} style={{
            width: '44px', height: '44px', borderRadius: '10px',
            background: 'rgba(26,26,46,0.9)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 12px rgba(0,0,0,0.2)', cursor: 'pointer', transition: 'all 0.2s ease'
          }} title={btn.title}>{btn.icon}</button>
        ))}

        <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '2px 4px' }} />

        <button onClick={handleMyLocation} disabled={isGettingLocation} style={{
          width: '44px', height: '44px', borderRadius: '10px',
          background: showMyLocation ? 'linear-gradient(135deg, #4285F4, #3367D6)' : 'rgba(26,26,46,0.9)',
          border: '1px solid rgba(255,255,255,0.08)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
          cursor: isGettingLocation ? 'default' : 'pointer', position: 'relative'
        }} title={showMyLocation ? "Hide My Location" : "Show My Location"}>
          {isGettingLocation ? <FaSpinner className="spin" size={16} /> : <FaLocationArrow size={16} />}
          {showMyLocation && (
            <span style={{
              position: 'absolute', top: '-4px', right: '-4px',
              width: '10px', height: '10px', borderRadius: '50%',
              backgroundColor: '#4285F4', border: '2px solid #0d0d1a'
            }} />
          )}
        </button>
      </nav>

      {/* RIGHT SIDEBAR */}
      {showSidebar && (
        <aside style={{
          position: 'fixed', right: 0, top: '56px', bottom: 0, width: '360px',
          backgroundColor: 'rgba(13,13,26,0.98)', backdropFilter: 'blur(16px)',
          color: '#ffffff', boxShadow: '-4px 0 40px rgba(0,0,0,0.6)',
          zIndex: 100, display: 'flex', flexDirection: 'column',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          animation: 'slideIn 0.25s ease'
        }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h6 style={{ margin: 0, fontSize: '14px', fontWeight: '700', letterSpacing: '0.5px', color: '#ffffff' }}>
                  <FaShieldAlt className="me-2 text-danger" size={14} /> DISPATCH CONTROL
                </h6>
                <small style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', letterSpacing: '0.3px', fontWeight: '500' }}>
                  {getDispatcherName()} • Gonzaga Fire Station
                </small>
              </div>
              <button onClick={() => setShowSidebar(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', padding: '4px', cursor: 'pointer' }}>
                <FaChevronLeft size={16} />
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
            {sidebarNavItems.map(item => {
              const isActive = activeSidebarTab === item.id;
              return (
                <div key={item.id} onClick={() => handleTabClick(item.id as any)} style={{
                  padding: '16px 18px', cursor: 'pointer',
                  backgroundColor: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
                  borderRadius: '12px', marginBottom: '4px',
                  display: 'flex', alignItems: 'center', gap: '14px',
                  borderLeft: isActive ? `4px solid ${item.color}` : '4px solid transparent',
                  transition: 'all 0.15s ease'
                }}>
                  <div style={{
                    width: '40px', height: '40px', borderRadius: '10px',
                    backgroundColor: `${item.color}22`, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    color: item.color, flexShrink: 0
                  }}>
                    <item.icon size={18} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '14px', fontWeight: '700', letterSpacing: '0.5px', color: isActive ? '#ffffff' : 'rgba(255,255,255,0.85)' }}>
                      {item.label}
                    </div>
                  </div>
                  {item.badge !== null && item.badge > 0 && (
                    <span
                      key={`${item.id}-${badgePulseKey}`}
                      style={{
                        backgroundColor: item.color, color: '#fff',
                        fontSize: '12px', fontWeight: '700', padding: '3px 14px',
                        borderRadius: '14px', flexShrink: 0,
                        animation: 'badge-pop 0.6s ease',
                      }}
                    >{item.badge}</span>
                  )}
                </div>
              );
            })}

            <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.55)', letterSpacing: '0.5px', marginBottom: '10px', paddingLeft: '4px' }}>
                <FaBullhorn className="me-2" size={11} /> EMERGENCY CONTROLS
              </div>
              <button onClick={handleTriggerFireAlarm} disabled={alarmTriggered || showFireAlarm} style={{
                width: '100%', padding: '14px', borderRadius: '10px',
                background: (alarmTriggered || showFireAlarm) ? 'rgba(220,53,69,0.2)' : 'linear-gradient(135deg, #dc3545, #a71d2a)',
                border: 'none', color: '#fff', fontSize: '14px', fontWeight: '700',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '10px', cursor: (alarmTriggered || showFireAlarm) ? 'default' : 'pointer', marginBottom: '8px'
              }}>
                <FaBullhorn size={16} /> {(alarmTriggered || showFireAlarm) ? '🚨 ALARM ACTIVE' : 'TRIGGER STATION ALARM'}
              </button>
              
              <div style={{
                fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.55)',
                letterSpacing: '0.5px', marginBottom: '10px', paddingLeft: '4px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}>
                <span>SYSTEM STATUS</span>
                <span style={{
                  fontSize: '10px',
                  fontVariantNumeric: 'tabular-nums',
                  fontWeight: '700',
                  color: liveLatencyMs < 500 ? '#4dff88'
                    : liveLatencyMs < 1500 ? '#ffc107'
                      : '#ff6b6b',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                }}>
                  <span style={{
                    width: '5px', height: '5px', borderRadius: '50%',
                    backgroundColor: liveLatencyMs < 500 ? '#4dff88'
                      : liveLatencyMs < 1500 ? '#ffc107'
                        : '#ff6b6b',
                    display: 'inline-block',
                    animation: liveLatencyMs > 0 ? 'pulse 1.5s infinite' : 'none',
                  }} />
                  {liveLatencyMs > 0 ? `${liveLatencyMs}ms` : '—'}
                </span>
              </div>

              {[
                { label: 'GPS Signal', value: systemStatus.gps, icon: FaSatelliteDish, type: 'gps' },
                { label: 'Network', value: systemStatus.network, icon: FaWifi, type: 'network' },
                { label: 'Emergency Broadcast', value: systemStatus.emergencyBroadcast, icon: FaBell, type: 'broadcast' },
              ].map((item, idx) => {
                const color = item.value === 'online' || item.value === 'active' ? '#28a745' :
                  item.value === 'error' || item.value === 'inactive' ? '#dc3545' : '#ffc107';
                return (
                  <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                    <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', fontWeight: '500' }}>
                      <item.icon size={11} className="me-2" style={{ color }} />
                      {item.label}
                    </span>
                    <span style={{ fontSize: '11px', fontWeight: '700', color }}>
                      {item.value === 'online' || item.value === 'active' ? 'ONLINE ✓' :
                        item.value === 'error' || item.value === 'inactive' ? '⚠️ OFFLINE' : '⏳ WAITING...'}
                    </span>
                  </div>
                );
              })}

              <div style={{
                fontSize: '10px', color: 'rgba(255,255,255,0.4)', textAlign: 'right',
                marginTop: '6px', paddingTop: '6px',
                borderTop: '1px solid rgba(255,255,255,0.05)', fontWeight: '500'
              }}>
                Updated: {systemStatus.lastUpdated.toLocaleTimeString()}
              </div>
            </div>
          </div>

          <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
            <button onClick={() => setShowLogoutConfirm(true)} style={{
              width: '100%', padding: '10px', borderRadius: '8px',
              background: 'rgba(220,53,69,0.12)', border: '1px solid rgba(220,53,69,0.2)',
              color: '#ff6b6b', fontSize: '12px', fontWeight: '700',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: '8px', cursor: 'pointer', transition: 'all 0.2s ease'
            }}>
              <FaSignOutAlt size={13} /> Logout
            </button>
          </div>
        </aside>
      )}

      {/* OVERLAY PANEL */}
      {showSidebar && showOverlay && (
        <div style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)', width: '560px', maxWidth: '92vw',
          maxHeight: '80vh', backgroundColor: 'rgba(13,13,26,0.98)',
          backdropFilter: 'blur(20px)', borderRadius: '16px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)',
          zIndex: 101, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          animation: 'fadeInScale 0.2s ease'
        }}>
          <div style={{
            padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0
          }}>
            <div>
              <h6 style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#ffffff' }}>
                <FaShieldAlt className="me-2 text-danger" size={13} /> {activeSidebarTab.toUpperCase()} PANEL
              </h6>
              <small style={{ color: 'rgba(255,255,255,0.6)', fontSize: '12px', fontWeight: '500' }}>
                {sidebarNavItems.find(i => i.id === activeSidebarTab)?.description}
              </small>
            </div>
            <button onClick={handleCloseOverlay} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', padding: '4px', cursor: 'pointer' }}>
              <FaTimesCircle size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
            {activeSidebarTab === 'dashboard' && (
              <div>
                <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '12px', padding: '16px', marginBottom: '16px', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div style={{ width: '44px', height: '44px', borderRadius: '50%', backgroundColor: 'rgba(23,162,184,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '14px' }}>
                      <FaUser size={18} className="text-info" />
                    </div>
                    <div>
                      <div style={{ color: '#ffffff', fontWeight: '700', fontSize: '15px' }}>{getDispatcherName()}</div>
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', fontWeight: '500' }}>{getDispatcherRole()} • Gonzaga Fire Station</div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontWeight: '500' }}>
                        <FaCalendarAlt className="me-1" size={9} />
                        {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                  {[
                    { label: 'Active Incidents', value: stats.activeIncidents, icon: FaFire, color: '#dc3545' },
                    { label: 'Resolved', value: stats.resolvedIncidents, icon: FaCheckCircle, color: '#28a745' },
                    { label: 'Active Units', value: stats.onlineUnits, icon: FaTruck, color: '#28a745' },
                    { label: 'High Threat Sensors', value: stats.highThreatSensors, icon: FaExclamationTriangle, color: '#ffc107' },
                    { label: 'Yellow Sensors', value: stats.yellowThreatSensors, icon: FaExclamationCircle, color: '#ffc107' },
                    { label: 'Mobile Emergencies', value: stats.mobileEmergencies, icon: FaPhoneAlt, color: '#dc3545' },
                    { label: 'Incoming Calls', value: stats.unacknowledgedEmergencies, icon: FaExclamationCircle, color: '#ff6b6b' },
                    { label: 'Verified', value: stats.verifiedEmergencies, icon: FaShieldAlt, color: '#17a2b8' },
                  ].map((stat, idx) => (
                    <div key={idx} style={{ flex: '0 0 calc(33.333% - 8px)', minWidth: '100px' }}>
                      <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '10px', padding: '12px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
                        <stat.icon size={14} style={{ color: stat.color, marginBottom: '2px' }} />
                        <div style={{ fontSize: '20px', fontWeight: '700', color: '#ffffff' }}>{stat.value}</div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', fontWeight: '500' }}>{stat.label}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '10px', padding: '14px', marginBottom: '16px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px' }}>
                    <FaUsers className="me-2 text-info" size={12} />
                    <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' }}>ACTIVE UNIT STATUS</span>
                  </div>
                  {['Dispatched', 'EnRoute', 'OnScene'].map((status) => {
                    const count = mapUnits.filter(u => u.status === status).length;
                    const total = mapUnits.length || 1;
                    const pct = (count / total) * 100;
                    const color = status === 'Dispatched' ? 'primary' : status === 'EnRoute' ? 'warning' : 'danger';
                    return (
                      <div key={status} style={{ marginBottom: '4px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'rgba(255,255,255,0.65)', fontWeight: '500' }}>
                          <span>{status}</span>
                          <span style={{ fontWeight: '700', color: '#ffffff' }}>{count}</span>
                        </div>
                        <div style={{ width: '100%', height: '3px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', backgroundColor: `var(--bs-${color})`, borderRadius: '2px' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.55)', letterSpacing: '0.5px', marginBottom: '8px' }}>
                  <FaHistory className="me-1" size={10} /> RECENT ACTIVITY
                </div>
                {incidents.filter(i => !isHiddenFromDispatcher(i)).slice(0, 2).map(incident => {
                  const normalizedStatus = normalizeIncidentStatus(incident.status);
                  const isResolved = normalizedStatus === 'Resolved';
                  return (
                    <div key={incident.incident_id}
                      onClick={() => { setSelectedIncident(incident); setShowIncidentModal(true); if (mapRef.current && hasValidCoords(incident)) mapRef.current.panTo({ lat: incident.latitude, lng: incident.longitude }); }}
                      style={{
                        background: isResolved ? 'rgba(40,167,69,0.08)' : 'rgba(255,255,255,0.05)',
                        borderRadius: '8px',
                        padding: '10px 14px', marginBottom: '6px', cursor: 'pointer',
                        borderLeft: `3px solid ${isResolved ? '#28a745' : normalizedStatus === 'Verified' ? '#17a2b8' : incident.threat_level === 'RED' ? '#dc3545' : '#ffc107'}`
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontSize: '11px', fontWeight: '700', color: isResolved ? 'rgba(255,255,255,0.5)' : normalizedStatus === 'Verified' ? '#4dd0e1' : incident.threat_level === 'RED' ? '#ff6b6b' : '#ffc107' }}>{incident.threat_level}</span>
                          <span style={{ fontSize: '12px', color: '#ffffff', marginLeft: '8px', fontWeight: '600' }}>{incident.incident_id}</span>
                        </div>
                        <span style={{
                          fontSize: '11px', padding: '2px 12px', borderRadius: '12px',
                          background: getStatusColor(normalizedStatus) + '40',
                          color: getStatusColor(normalizedStatus),
                          fontWeight: '600',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}>
                          {isResolved && <FaCheckCircle size={9} />}
                          {normalizedStatus}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '2px', fontWeight: '500' }}>
                        {new Date(incident.reported_at).toLocaleTimeString()}
                      </div>
                    </div>
                  );
                })}
                {mobileEmergencies.slice(0, 2).map(emergency => (
                  <div key={emergency.id}
                    onClick={() => { setSelectedMobileEmergency(emergency); setShowMobileEmergencyModal(true); if (mapRef.current && hasValidCoords(emergency)) mapRef.current.panTo({ lat: emergency.latitude, lng: emergency.longitude }); }}
                    style={{
                      background: 'rgba(255,255,255,0.05)', borderRadius: '8px',
                      padding: '10px 14px', marginBottom: '6px', cursor: 'pointer',
                      borderLeft: `3px solid ${emergency.verified ? '#17a2b8' : emergency.acknowledged ? '#28a745' : '#dc3545'}`
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <FaPhone size={10} style={{ color: emergency.verified ? '#17a2b8' : emergency.acknowledged ? '#28a745' : '#dc3545', marginRight: '6px' }} />
                        <span style={{ fontSize: '12px', color: '#ffffff', fontWeight: '600' }}>{emergency.caller_name || 'Unknown Caller'}</span>
                      </div>
                      <span style={{
                        fontSize: '11px', padding: '2px 12px', borderRadius: '12px',
                        background: emergency.verified ? 'rgba(23,162,184,0.25)' : emergency.acknowledged ? 'rgba(40,167,69,0.25)' : 'rgba(220,53,69,0.25)',
                        color: emergency.verified ? '#4dd0e1' : emergency.acknowledged ? '#4dff88' : '#ff6b6b', fontWeight: '600'
                      }}>
                        {emergency.verified ? '✓ Verified' : emergency.acknowledged ? '✓ Acknowledged' : '📞 Incoming'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeSidebarTab === 'emergencies' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' }}>
                    <FaPhoneAlt className="me-1 text-danger" size={12} /> INCOMING EMERGENCY CALLS
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>
                      {unacknowledgedEmergencies.length} incoming · {verifiedEmergencies.length} verified
                    </span>
                    {mobileEmergencies.length > 0 && (
                      <button onClick={clearAllMobileEmergencies} style={{
                        background: 'rgba(220,53,69,0.15)', border: '1px solid rgba(220,53,69,0.25)',
                        borderRadius: '4px', padding: '2px 10px', color: '#ff6b6b',
                        fontSize: '10px', cursor: 'pointer', fontWeight: '600'
                      }}>
                        <FaTrash size={10} className="me-1" /> Clear All ({mobileEmergencies.length})
                      </button>
                    )}
                  </div>
                </div>

                {mobileEmergencies.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <FaPhoneAlt size={28} style={{ color: 'rgba(255,255,255,0.15)' }} />
                    <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', marginTop: '8px', fontWeight: '500' }}>No incoming emergency calls</p>
                  </div>
                ) : mobileEmergencies.slice(0, 10).map(emergency => (
                  <div key={emergency.id}
                    onClick={() => { setSelectedMobileEmergency(emergency); setShowMobileEmergencyModal(true); if (mapRef.current && hasValidCoords(emergency)) mapRef.current.panTo({ lat: emergency.latitude, lng: emergency.longitude }); }}
                    style={{
                      background: 'rgba(255,255,255,0.05)', borderRadius: '8px',
                      padding: '12px 14px', marginBottom: '6px', cursor: 'pointer',
                      border: `2px solid ${emergency.resolved
                          ? 'rgba(40,167,69,0.35)'
                          : emergency.verified
                            ? 'rgba(23,162,184,0.55)'
                            : emergency.acknowledged
                              ? 'rgba(40,167,69,0.25)'
                              : 'rgba(220,53,69,0.5)'
                        }`,
                      position: 'relative'
                    }}>
                    {!emergency.acknowledged && (
                      <div style={{
                        position: 'absolute', top: '6px', right: '6px',
                        background: '#dc3545', color: '#fff', fontSize: '9px',
                        fontWeight: '700', padding: '2px 10px', borderRadius: '10px',
                        animation: 'pulse-glow-fast 1s infinite', letterSpacing: '0.5px'
                      }}>📞 INCOMING</div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {emergency.resolved ? <FaCheckCircle size={12} style={{ color: '#28a745' }} /> : emergency.verified ? <FaShieldAlt size={12} style={{ color: '#17a2b8' }} /> : <FaPhone size={12} style={{ color: emergency.acknowledged ? '#28a745' : '#dc3545' }} />}
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ffffff', wordBreak: 'break-word' }}>
                            {emergency.caller_name || 'Unknown Caller'}
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginTop: '2px', fontWeight: '500' }}>
                          📞 {emergency.caller_phone || 'No phone'}
                        </div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', marginTop: '1px', fontWeight: '500' }}>
                          📍 {emergency.address || `${emergency.latitude.toFixed(4)}, ${emergency.longitude.toFixed(4)}`}
                        </div>
                        {emergency.incident_id && !emergency.resolved && (
                          <div style={{ fontSize: '11px', color: '#4dd0e1', marginTop: '2px', fontWeight: '700' }}>
                            🔥 Incident: {emergency.incident_id}
                          </div>
                        )}
                      </div>
                      <span style={{
                        fontSize: '11px', padding: '2px 12px', borderRadius: '12px',
                        background: emergency.resolved
                          ? 'rgba(40,167,69,0.25)'
                          : emergency.verified
                            ? 'rgba(23,162,184,0.25)'
                            : emergency.acknowledged
                              ? 'rgba(40,167,69,0.25)'
                              : 'rgba(220,53,69,0.25)',
                        color: emergency.resolved
                          ? '#4dff88'
                          : emergency.verified
                            ? '#4dd0e1'
                            : emergency.acknowledged
                              ? '#4dff88'
                              : '#ff6b6b',
                        fontWeight: '600'
                      }}>
                        {emergency.resolved ? '✓ Resolved' : emergency.verified ? '✓ Verified' : emergency.acknowledged ? '✓ Acknowledged' : '📞 Incoming'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                      {!emergency.acknowledged && (
                        <button onClick={(e) => { e.stopPropagation(); acknowledgeMobileEmergency(emergency); }} style={{
                          flex: 1, background: '#28a745', border: 'none', borderRadius: '6px',
                          padding: '6px', color: '#fff', fontSize: '12px', fontWeight: '700',
                          cursor: 'pointer', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '6px', minWidth: '80px'
                        }}>
                          <FaCheck size={11} /> Answer
                        </button>
                      )}

                      {emergency.acknowledged && !emergency.verified && !emergency.resolved && (
                        <button
                          onClick={(e) => { e.stopPropagation(); verifyMobileEmergency(emergency); }}
                          disabled={processing}
                          style={{
                            flex: 1,
                            background: 'linear-gradient(135deg, #17a2b8, #117a8b)',
                            border: 'none', borderRadius: '6px', padding: '6px',
                            color: '#fff', fontSize: '12px', fontWeight: '700',
                            cursor: processing ? 'default' : 'pointer',
                            display: 'flex', alignItems: 'center',
                            justifyContent: 'center', gap: '6px', minWidth: '80px',
                            boxShadow: '0 2px 12px rgba(23,162,184,0.35)'
                          }}
                        >
                          {processing ? <FaSpinner className="spin" size={11} /> : <FaShieldAlt size={11} />}
                          Verify
                        </button>
                      )}

                      {emergency.verified && !emergency.resolved && (
                        <div style={{
                          flex: 1, background: 'rgba(23,162,184,0.18)',
                          border: '1px solid rgba(23,162,184,0.35)',
                          borderRadius: '6px', padding: '6px',
                          color: '#4dd0e1', fontSize: '12px', fontWeight: '700',
                          display: 'flex', alignItems: 'center',
                          justifyContent: 'center', gap: '6px', minWidth: '80px'
                        }}>
                          <FaCheckCircle size={11} /> Verified
                        </div>
                      )}

                      <button onClick={(e) => { e.stopPropagation(); routeBFPToMobileEmergency({ lat: emergency.latitude, lng: emergency.longitude, name: emergency.caller_name || 'caller' }); }} disabled={routeLoading} style={{
                        flex: 1, background: 'rgba(13,110,253,0.15)', border: '1px solid rgba(13,110,253,0.25)',
                        borderRadius: '6px', padding: '6px', color: '#4d9aff', fontSize: '12px',
                        fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', gap: '6px', minWidth: '80px'
                      }}>
                        {routeLoading ? <FaSpinner className="spin" size={11} /> : <FaDirections size={11} />} Route
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteMobileEmergency(emergency); }} style={{
                        background: 'rgba(220,53,69,0.15)', border: '1px solid rgba(220,53,69,0.25)',
                        borderRadius: '6px', padding: '6px 12px', color: '#ff6b6b', fontSize: '12px',
                        fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center',
                        justifyContent: 'center', gap: '4px'
                      }}>
                        <FaTrash size={11} /> Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeSidebarTab === 'incidents' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' }}>
                    <FaFire className="me-1 text-danger" size={12} /> INCIDENT LIST
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>
                      {filteredIncidents.length} shown
                    </span>
                    {filteredIncidents.length > 0 && (
                      <button
                        onClick={clearAllIncidents}
                        disabled={processing}
                        title="Remove all incidents from the dispatcher map (data is preserved for Admin)"
                        style={{
                          background: 'rgba(220,53,69,0.15)',
                          border: '1px solid rgba(220,53,69,0.25)',
                          borderRadius: '4px',
                          padding: '2px 10px',
                          color: '#ff6b6b',
                          fontSize: '10px',
                          cursor: processing ? 'default' : 'pointer',
                          fontWeight: '600',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          opacity: processing ? 0.6 : 1,
                        }}
                      >
                        {processing ? (
                          <FaSpinner className="spin" size={10} />
                        ) : (
                          <FaTrash size={10} />
                        )}
                        Clear All ({filteredIncidents.length})
                      </button>
                    )}
                    <select value={incidentFilter} onChange={(e) => setIncidentFilter(e.target.value)} style={dropdownStyle}>
                      <option value="all" style={dropdownOptionStyle}>All Status</option>
                      <option value="Received" style={dropdownOptionStyle}>Received</option>
                      <option value="Verified" style={dropdownOptionStyle}>Verified</option>
                      <option value="Dispatched" style={dropdownOptionStyle}>Dispatched</option>
                      <option value="EnRoute" style={dropdownOptionStyle}>En Route</option>
                      <option value="OnScene" style={dropdownOptionStyle}>On Scene</option>
                      <option value="Resolved" style={dropdownOptionStyle}>Resolved</option>
                      <option value="Cancelled" style={dropdownOptionStyle}>Cancelled</option>
                    </select>
                  </div>
                </div>
                {filteredIncidents.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <FaFire size={28} style={{ color: 'rgba(255,255,255,0.15)' }} />
                    <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', marginTop: '8px', fontWeight: '500' }}>No incidents found</p>
                  </div>
                ) : filteredIncidents.slice(0, INCIDENT_LIST_LIMIT).map(incident => {
                  const normalizedStatus = normalizeIncidentStatus(incident.status);
                  const isResolved = normalizedStatus === 'Resolved';
                  const isCancelled = normalizedStatus === 'Cancelled';
                  const isTerminal = isResolved || isCancelled;
                  const resolvedAtText = isResolved ? formatResolvedTime((incident as any).resolved_at) : '';

                  return (
                    <div key={incident.incident_id}
                      onClick={() => {
                        setSelectedIncident(incident);
                        setShowIncidentModal(true);
                        if (mapRef.current && hasValidCoords(incident)) mapRef.current.panTo({ lat: incident.latitude, lng: incident.longitude });
                      }}
                      style={{
                        background: isResolved
                          ? 'rgba(40,167,69,0.08)'
                          : isCancelled
                            ? 'rgba(108,117,125,0.08)'
                            : 'rgba(255,255,255,0.05)',
                        borderRadius: '8px',
                        padding: '12px 14px',
                        marginBottom: '6px',
                        cursor: 'pointer',
                        borderLeft: `3px solid ${isResolved ? '#28a745'
                            : isCancelled ? '#6c757d'
                              : normalizedStatus === 'Verified' ? '#17a2b8'
                                : incident.threat_level === 'RED' ? '#dc3545'
                                  : '#ffc107'
                          }`,
                        opacity: isTerminal ? 0.85 : 1,
                        transition: 'all 0.15s ease',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {isResolved && (
                              <FaCheckCircle size={12} style={{ color: '#28a745' }} />
                            )}
                            {isCancelled && (
                              <FaTimesCircle size={12} style={{ color: '#6c757d' }} />
                            )}
                            {normalizedStatus === 'Verified' && !isTerminal && (
                              <FaShieldAlt size={11} style={{ color: '#17a2b8' }} />
                            )}
                            <span style={{
                              fontSize: '11px',
                              fontWeight: '700',
                              color: isTerminal
                                ? 'rgba(255,255,255,0.5)'
                                : normalizedStatus === 'Verified'
                                  ? '#4dd0e1'
                                  : incident.threat_level === 'RED'
                                    ? '#ff6b6b'
                                    : '#ffc107'
                            }}>
                              {incident.threat_level}
                            </span>
                            <span style={{
                              fontSize: '12px',
                              color: isTerminal ? 'rgba(255,255,255,0.6)' : '#ffffff',
                              fontWeight: '600',
                              textDecoration: isTerminal ? 'line-through' : 'none',
                            }}>
                              {incident.incident_id}
                            </span>
                          </div>
                        </div>
                        <span style={{
                          fontSize: '11px',
                          padding: '2px 12px',
                          borderRadius: '12px',
                          background: getStatusColor(normalizedStatus) + (isTerminal ? '30' : '40'),
                          color: getStatusColor(normalizedStatus),
                          fontWeight: '700',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          flexShrink: 0,
                          border: isTerminal ? `1px solid ${getStatusColor(normalizedStatus)}50` : 'none',
                        }}>
                          {isResolved && <FaCheckCircle size={9} />}
                          {isCancelled && <FaTimesCircle size={9} />}
                          {normalizedStatus}
                        </span>
                      </div>
                      <div style={{
                        fontSize: '11px',
                        color: 'rgba(255,255,255,0.55)',
                        marginTop: '2px',
                        fontWeight: '500',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}>
                        <FaMapMarkerAlt size={8} />
                        {incident.location_address || `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                      </div>

                      {isResolved && resolvedAtText && (
                        <div style={{
                          fontSize: '10px',
                          color: '#4dff88',
                          marginTop: '4px',
                          fontWeight: '600',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          background: 'rgba(40,167,69,0.1)',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          border: '1px solid rgba(40,167,69,0.2)',
                        }}>
                          <FaCheckCircle size={9} />
                          Resolved: {resolvedAtText}
                        </div>
                      )}

                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                        <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.45)', fontWeight: '500' }}>
                          {new Date(incident.reported_at).toLocaleString()}
                        </span>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {normalizedStatus === 'Verified' && !isTerminal && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedIncident(incident);
                                setSelectedUnits([]);
                                setShowDispatchModal(true);
                              }}
                              disabled={processing}
                              title="Dispatch response units to this incident"
                              style={{
                                background: 'rgba(13,110,253,0.18)',
                                border: '1px solid rgba(13,110,253,0.35)',
                                borderRadius: '4px',
                                padding: '3px 10px',
                                fontSize: '11px',
                                color: '#4d9aff',
                                cursor: processing ? 'default' : 'pointer',
                                fontWeight: '700',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                opacity: processing ? 0.6 : 1,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              <FaTruck size={8} />
                              Dispatch
                            </button>
                          )}

                          {isResolved && (
                            <div
                              title={resolvedAtText ? `Resolved at ${resolvedAtText}` : 'This incident has been resolved'}
                              style={{
                                background: 'rgba(40,167,69,0.15)',
                                border: '1px solid rgba(40,167,69,0.35)',
                                borderRadius: '4px',
                                padding: '3px 10px',
                                fontSize: '11px',
                                color: '#4dff88',
                                fontWeight: '700',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <FaCheckCircle size={8} /> Resolved
                            </div>
                          )}

                          {isCancelled && (
                            <div
                              title="This incident has been cancelled"
                              style={{
                                background: 'rgba(108,117,125,0.15)',
                                border: '1px solid rgba(108,117,125,0.35)',
                                borderRadius: '4px',
                                padding: '3px 10px',
                                fontSize: '11px',
                                color: 'rgba(255,255,255,0.6)',
                                fontWeight: '700',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <FaTimesCircle size={8} /> Cancelled
                            </div>
                          )}

                          <button
                            onClick={(e) => { e.stopPropagation(); routeBFPToIncident(incident); }}
                            disabled={routeLoading}
                            style={{
                              background: 'rgba(13,110,253,0.15)', border: 'none', borderRadius: '4px',
                              padding: '3px 12px', fontSize: '11px', color: '#4d9aff',
                              cursor: routeLoading ? 'default' : 'pointer', fontWeight: '600',
                              display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                          >
                            {routeLoading ? <FaSpinner className="spin" size={8} /> : <><FaDirections size={8} /> Route</>}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteIncident(incident); }}
                            disabled={processing}
                            title="Remove from dispatcher map (data kept for Admin)"
                            style={{
                              background: 'rgba(220,53,69,0.15)',
                              border: '1px solid rgba(220,53,69,0.25)',
                              borderRadius: '4px', padding: '3px 10px', fontSize: '11px',
                              color: '#ff6b6b', cursor: processing ? 'default' : 'pointer',
                              fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                          >
                            <FaTrash size={8} /> Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredIncidents.length > INCIDENT_LIST_LIMIT && (
                  <div style={{ textAlign: 'center', padding: '8px', fontSize: '11px', color: 'rgba(255,255,255,0.4)', fontWeight: '500' }}>
                    Showing {INCIDENT_LIST_LIMIT} of {filteredIncidents.length} — use the filter to narrow results
                  </div>
                )}
              </div>
            )}

            {activeSidebarTab === 'units' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' }}>
                    <FaTruck className="me-1 text-success" size={12} /> RESPONSE UNITS
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {units.length > 0 && (
                      <button
                        onClick={resetAllUnitsToAvailable}
                        disabled={processing}
                        title="Force all units back to Available (cancels active dispatches)"
                        style={{
                          background: 'rgba(255,193,7,0.15)',
                          border: '1px solid rgba(255,193,7,0.35)',
                          borderRadius: '4px',
                          padding: '2px 10px',
                          color: '#ffc107',
                          fontSize: '10px',
                          cursor: processing ? 'default' : 'pointer',
                          fontWeight: '600',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          opacity: processing ? 0.6 : 1,
                        }}
                      >
                        {processing ? <FaSpinner className="spin" size={10} /> : <FaSync size={10} />}
                        Reset All
                      </button>
                    )}
                    <select value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)} style={dropdownStyle}>
                      <option value="all" style={dropdownOptionStyle}>All</option>
                      <option value="Available" style={dropdownOptionStyle}>Available</option>
                      <option value="Dispatched" style={dropdownOptionStyle}>Dispatched</option>
                      <option value="EnRoute" style={dropdownOptionStyle}>En Route</option>
                      <option value="OnScene" style={dropdownOptionStyle}>On Scene</option>
                    </select>
                  </div>
                </div>
                {filteredUnits.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <FaTruck size={28} style={{ color: 'rgba(255,255,255,0.15)' }} />
                    <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', marginTop: '8px', fontWeight: '500' }}>No units found</p>
                  </div>
                ) : filteredUnits.slice(0, 6).map(unit => {
                  const online = isUnitOnline(unit);
                  const latest = latestDispatchByUnit.get(unit.unit_id);
                  const onMap = !!(latest && !latest.isTerminal) && online && hasValidCoords(unit);
                  return (
                    <div key={unit.unit_id} style={{
                      background: 'rgba(255,255,255,0.05)', borderRadius: '8px',
                      padding: '12px 14px', marginBottom: '6px',
                      border: online ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(220,53,69,0.25)',
                      opacity: online ? 1 : 0.6,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <span style={{ fontSize: '13px', fontWeight: '700', color: '#ffffff' }}>{unit.unit_name}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', marginLeft: '6px', fontWeight: '500' }}>({unit.unit_code})</span>
                          <span style={{
                            marginLeft: '8px',
                            fontSize: '10px',
                            fontWeight: '700',
                            color: online ? '#4dff88' : '#ff6b6b',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}>
                            <span style={{
                              width: '6px', height: '6px', borderRadius: '50%',
                              backgroundColor: online ? '#4dff88' : '#ff6b6b',
                              display: 'inline-block',
                              animation: online ? 'pulse 2s infinite' : 'none',
                            }} />
                            {online ? 'ONLINE' : 'OFFLINE'}
                          </span>
                          {onMap && (
                            <span style={{
                              marginLeft: '8px',
                              fontSize: '10px',
                              fontWeight: '700',
                              color: '#4dd0e1',
                            }}>· ON MAP</span>
                          )}
                        </div>
                        <span style={{ fontSize: '11px', padding: '2px 12px', borderRadius: '12px', background: getStatusColor(unit.status) + '40', color: getStatusColor(unit.status), fontWeight: '600' }}>{unit.status}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '2px', fontWeight: '500' }}>
                        <FaMapMarkerAlt className="me-1" size={8} />
                        {unit.latitude.toFixed(6)}, {unit.longitude.toFixed(6)}
                      </div>

                      {(() => {
                        const lastActive = (unit as any).last_active as number | undefined;
                        if (!lastActive) return null;
                        const seconds = Math.round((Date.now() - lastActive) / 1000);
                        const isFresh = seconds < 30;
                        return (
                          <div style={{ marginTop: '4px' }}>
                            <span style={{
                              fontSize: '10px',
                              color: isFresh ? '#4dff88' : '#ffc107',
                              fontWeight: '600',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}>
                              <span style={{
                                width: '5px', height: '5px', borderRadius: '50%',
                                backgroundColor: isFresh ? '#4dff88' : '#ffc107',
                                display: 'inline-block',
                                animation: isFresh ? 'pulse 2s infinite' : 'none',
                              }} />
                              {isFresh ? 'LIVE' : `${seconds}s ago`}
                            </span>
                          </div>
                        );
                      })()}

                      {selectedIncident && unit.status === 'Available' && online && hasValidCoords(unit) && hasValidCoords(selectedIncident) && (
                        <button onClick={() => routeUnitToIncident(unit, selectedIncident)} disabled={routeLoading} style={{
                          width: '100%', marginTop: '6px',
                          background: 'rgba(23,162,184,0.15)',
                          border: '1px solid rgba(23,162,184,0.25)',
                          borderRadius: '4px', padding: '5px', fontSize: '11px',
                          color: '#4dd0e1', cursor: 'pointer', fontWeight: '600'
                        }}>
                          {routeLoading ? <FaSpinner className="spin" size={10} /> : <><FaDirections size={10} className="me-1" /> Route to Caller</>}
                        </button>
                      )}

                      {unit.status !== 'Available' && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!window.confirm(`Force ${unit.unit_name} back to Available?`)) return;

                            try {
                              const q = query(
                                collection(firestore, 'unit_dispatches'),
                                where('target_unit_id', '==', unit.unit_id),
                                where('acknowledged', '==', false)
                              );
                              const snap = await getDocs(q);
                              for (const docSnap of snap.docs) {
                                await updateDoc(doc(firestore, 'unit_dispatches', docSnap.id), {
                                  status: 'cancelled',
                                  cancelled: true,
                                  cancelled_at: serverTimestamp(),
                                  cancelled_by: 'dispatcher_manual',
                                }).catch(() => { });
                              }

                              await updateUnitStatus(unit.unit_id, 'Available', null as any);
                              setUnits(prev => prev.map(u =>
                                u.unit_id === unit.unit_id
                                  ? { ...u, status: 'Available', current_incident_id: null }
                                  : u
                              ));
                              toast.success(`✅ ${unit.unit_name} reset to Available`);
                            } catch (err) {
                              console.error('Force Available failed:', err);
                              toast.error('Failed to reset unit');
                            }
                          }}
                          style={{
                            background: 'rgba(255,193,7,0.15)',
                            border: '1px solid rgba(255,193,7,0.35)',
                            borderRadius: '4px',
                            padding: '3px 10px',
                            fontSize: '11px',
                            color: '#ffc107',
                            cursor: 'pointer',
                            fontWeight: '600',
                            marginTop: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            width: '100%',
                            justifyContent: 'center',
                          }}
                        >
                          <FaTimesCircle size={10} /> Force Available
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {activeSidebarTab === 'sensors' && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <span style={{ fontSize: '12px', fontWeight: '700', color: 'rgba(255,255,255,0.7)' }}>
                    <FaSatelliteDish className="me-1 text-warning" size={12} /> IoT SENSORS
                  </span>
                  <select value={sensorFilter} onChange={(e) => setSensorFilter(e.target.value)} style={dropdownStyle}>
                    <option value="all" style={dropdownOptionStyle}>All</option>
                    <option value="RED" style={dropdownOptionStyle}>High Threat</option>
                    <option value="YELLOW" style={dropdownOptionStyle}>Low Threat</option>
                  </select>
                </div>
                {filteredSensors.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <FaSatelliteDish size={28} style={{ color: 'rgba(255,255,255,0.15)' }} />
                    <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px', marginTop: '8px', fontWeight: '500' }}>No sensors found</p>
                  </div>
                ) : filteredSensors.slice(0, 6).map(sensor => {
                  const liveDoc = sensors.find(s => s.sensor_id === sensor.sensor_id);
                  const live = liveDoc ? isSensorLive(liveDoc) : false;
                  const visible = isSensorVisibleOnDispatcherMap(sensor);
                  return (
                    <div key={sensor.sensor_id} style={{
                      background: 'rgba(255,255,255,0.05)', borderRadius: '8px',
                      padding: '12px 14px', marginBottom: '6px',
                      border: `1px solid ${sensor.threat_level === 'RED' && visible ? 'rgba(220,53,69,0.3)' : 'rgba(255,255,255,0.06)'}`,
                      opacity: visible ? 1 : 0.55,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <span style={{ fontSize: '12px', color: '#ffffff', fontWeight: '600' }}>{sensor.sensor_type}</span>
                          <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', marginLeft: '6px', fontWeight: '500' }}>({sensor.sensor_id})</span>
                          {!live && visible && (
                            <span style={{
                              marginLeft: '8px', fontSize: '10px', fontWeight: '700',
                              color: '#ffc107', display: 'inline-flex', alignItems: 'center', gap: '4px'
                            }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#ffc107', display: 'inline-block' }} />
                              STALE PIN
                            </span>
                          )}
                          {!live && !visible && (
                            <span style={{
                              marginLeft: '8px', fontSize: '10px', fontWeight: '700',
                              color: '#888', display: 'inline-flex', alignItems: 'center', gap: '4px'
                            }}>
                              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#888', display: 'inline-block' }} />
                              OFFLINE
                            </span>
                          )}
                        </div>
                        {sensor.threat_level === 'RED' && visible && (
                          <span style={{ fontSize: '10px', fontWeight: '700', padding: '2px 12px', borderRadius: '12px', background: '#dc3545', color: '#fff', animation: 'pulse-glow 1s infinite' }}>HIGH</span>
                        )}
                        {sensor.threat_level === 'YELLOW' && visible && (
                          <span style={{ fontSize: '10px', fontWeight: '700', padding: '2px 12px', borderRadius: '12px', background: '#ffc107', color: '#000' }}>LOW</span>
                        )}
                        {(!sensor.threat_level || !visible) && (
                          <span style={{ fontSize: '10px', fontWeight: '700', padding: '2px 12px', borderRadius: '12px', background: live ? '#28a745' : '#6c757d', color: '#fff' }}>{live ? 'NORMAL' : 'OFFLINE'}</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '2px', fontWeight: '500' }}>
                        <FaMapMarkerAlt className="me-1" size={8} />
                        {sensor.location_name || sensor.location}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                        <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>
                          Status: <span style={{ color: live ? '#4dff88' : '#ff6b6b', fontWeight: '600' }}>{sensor.status}</span>
                        </span>
                        <button onClick={() => routeBFPToSensor(sensor)} disabled={routeLoading} style={{
                          background: 'rgba(13,110,253,0.15)', border: 'none', borderRadius: '4px',
                          padding: '3px 12px', fontSize: '11px', color: '#4d9aff',
                          cursor: 'pointer', fontWeight: '600'
                        }}>
                          {routeLoading ? <FaSpinner className="spin" size={8} /> : <><FaDirections size={8} className="me-1" /> Route</>}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* LOGOUT CONFIRM MODAL */}
      <Modal show={showLogoutConfirm} onHide={() => setShowLogoutConfirm(false)} centered>
        <Modal.Header closeButton style={{ background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#fff' }}>
          <Modal.Title style={{ fontSize: '16px', fontWeight: '600' }}>
            <FaSignOutAlt className="me-2 text-danger" size={14} /> Confirm Logout
          </Modal.Title>
        </Modal.Header>
        <Modal.Body style={{ background: '#0d0d1a', color: 'rgba(255,255,255,0.85)', fontSize: '14px', fontWeight: '500' }}>
          <p>Are you sure you want to logout?</p>
          <p className="text-muted small mb-0" style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)' }}>You will be redirected to the login page.</p>
        </Modal.Body>
        <Modal.Footer style={{ background: '#0d0d1a', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setShowLogoutConfirm(false)} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '6px', padding: '8px 18px', color: 'rgba(255,255,255,0.7)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleLogout} style={{ background: '#dc3545', border: 'none', borderRadius: '6px', padding: '8px 18px', color: '#fff', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}>
            <FaSignOutAlt className="me-2" size={11} /> Logout
          </button>
        </Modal.Footer>
      </Modal>

      {/* SENSOR DETAIL MODAL */}
      <Modal show={showSensorModal} onHide={() => setShowSensorModal(false)} size="lg" centered>
        <Modal.Header closeButton style={{ background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#fff' }}>
          <Modal.Title style={{ fontSize: '16px', fontWeight: '600' }}>
            <FaSatelliteDish className="me-2" style={{ color: '#ff6b6b' }} size={14} />
            Sensor Alert — {selectedSensor?.sensor_id}
          </Modal.Title>
        </Modal.Header>
        {selectedSensor && (() => {
          const liveDoc = sensors.find(s => s.sensor_id === selectedSensor.sensor_id);
          const isLive = liveDoc ? isSensorLive(liveDoc) : false;
          return (
          <Modal.Body style={{ background: '#0d0d1a', color: '#fff' }}>
            <div style={{ marginBottom: '12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {selectedSensor.verified ? (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(13,110,253,0.25)', color: '#4d9aff',
                  display: 'inline-flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheckCircle size={10} /> VERIFIED — INCIDENT {selectedSensor.incident_id}
                </span>
              ) : selectedSensor.dispatcher_acknowledged ? (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(255,193,7,0.25)', color: '#ffc107',
                  display: 'inline-flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheck size={10} /> ACKNOWLEDGED — NOT YET VERIFIED
                </span>
              ) : (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(220,53,69,0.3)', color: '#ff6b6b',
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  animation: 'pulse-glow-fast 1s infinite'
                }}>
                  <FaExclamationTriangle size={10} /> UNACKNOWLEDGED FIRE ALERT
                </span>
              )}
              {selectedSensor.threat_level === 'RED' && (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(220,53,69,0.25)', color: '#ff6b6b'
                }}>
                  🔥 HIGH THREAT
                </span>
              )}
              {selectedSensor.threat_level === 'YELLOW' && (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(255,193,7,0.25)', color: '#ffc107'
                }}>
                  ⚠️ LOW THREAT
                </span>
              )}
              {!isLive && (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(108,117,125,0.25)', color: 'rgba(255,255,255,0.7)'
                }}>
                  ⚫ SENSOR OFFLINE (PIN STICKY)
                </span>
              )}
            </div>

            <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                <FaSatelliteDish className="me-2" style={{ color: '#ffc107' }} size={11} />
                <span style={{ color: '#fff' }}>
                  {selectedSensor.sensor_type} — <strong>{selectedSensor.sensor_id}</strong>
                </span>
              </div>

              {selectedSensor.location_name && (
                <div style={{ fontSize: '14px', marginBottom: '4px', color: '#4dff88', fontWeight: '700' }}>
                  📍 {selectedSensor.location_name}
                </div>
              )}

              {(selectedSensor.building || selectedSensor.room || selectedSensor.floor) && (
                <div style={{ fontSize: '12px', marginBottom: '4px', color: 'rgba(255,255,255,0.7)', fontWeight: '500' }}>
                  {[selectedSensor.building, selectedSensor.room, selectedSensor.floor].filter(Boolean).join(' • ')}
                </div>
              )}

              {!selectedSensor.location_name && (
                <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                  📍 {selectedSensor.location || 'Unknown Location'}
                </div>
              )}

              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', marginTop: '8px', fontFamily: 'monospace', fontWeight: '500' }}>
                {selectedSensor.latitude.toFixed(6)}, {selectedSensor.longitude.toFixed(6)}
              </div>

              {selectedSensor.temperature != null && (
                <div style={{ fontSize: '12px', color: '#ff6b6b', marginTop: '6px', fontWeight: '700' }}>
                  🌡️ Temperature: {selectedSensor.temperature}°C
                </div>
              )}
              {selectedSensor.humidity != null && (
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', marginTop: '2px', fontWeight: '600' }}>
                  💧 Humidity: {selectedSensor.humidity}%
                </div>
              )}
              {selectedSensor.verified && selectedSensor.verified_by_name && (
                <div style={{ fontSize: '12px', color: '#4d9aff', marginTop: '8px', fontWeight: '600' }}>
                  <FaShieldAlt className="me-1" size={10} />
                  Verified by: <strong>{selectedSensor.verified_by_name}</strong>
                </div>
              )}
            </div>

            <hr style={{ borderColor: 'rgba(255,255,255,0.08)' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {!selectedSensor.dispatcher_acknowledged && !selectedSensor.verified && (
                <button onClick={() => acknowledgeSensor(selectedSensor)} style={{
                  background: 'rgba(255,193,7,0.2)',
                  border: '1px solid rgba(255,193,7,0.4)',
                  borderRadius: '6px', padding: '8px 20px',
                  color: '#ffc107', fontSize: '13px', fontWeight: '700',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheck size={11} /> Acknowledge Alert
                </button>
              )}

              {!selectedSensor.verified && (
                <button
                  onClick={() => verifySensorAndCreateIncident(selectedSensor)}
                  disabled={processing}
                  style={{
                    background: selectedSensor.threat_level === 'YELLOW'
                      ? 'linear-gradient(135deg, #ffc107, #d39e00)'
                      : 'linear-gradient(135deg, #17a2b8, #117a8b)',
                    border: 'none', borderRadius: '6px',
                    padding: '8px 20px',
                    color: selectedSensor.threat_level === 'YELLOW' ? '#1a1a2e' : '#fff',
                    fontSize: '13px', fontWeight: '700',
                    cursor: processing ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px',
                    boxShadow: selectedSensor.threat_level === 'YELLOW'
                      ? '0 4px 16px rgba(255,193,7,0.35)'
                      : '0 4px 16px rgba(23,162,184,0.35)'
                  }}
                >
                  {processing ? <FaSpinner className="spin" size={11} /> : <FaShieldAlt size={11} />}
                  Verify & Create Incident
                </button>
              )}

              {selectedSensor.verified && selectedSensor.incident_id && (
                <button
                  onClick={() => {
                    const inc = incidents.find(i => i.incident_id === selectedSensor.incident_id);
                    if (inc) {
                      setSelectedIncident(inc);
                      setShowIncidentModal(true);
                      setShowSensorModal(false);
                    } else {
                      toast.error('Incident not loaded yet — try again in a moment');
                    }
                  }}
                  style={{
                    background: 'rgba(13,110,253,0.2)',
                    border: '1px solid rgba(13,110,253,0.4)',
                    borderRadius: '6px', padding: '8px 20px',
                    color: '#4d9aff', fontSize: '13px', fontWeight: '700',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                  }}
                >
                  <FaFire size={11} /> Open Incident {selectedSensor.incident_id}
                </button>
              )}

              <button onClick={() => { routeBFPToSensor(selectedSensor); setShowSensorModal(false); }} disabled={routeLoading} style={{
                background: 'rgba(13,110,253,0.15)', border: '1px solid rgba(13,110,253,0.25)',
                borderRadius: '6px', padding: '8px 20px', color: '#4d9aff',
                fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                {routeLoading ? <FaSpinner className="spin" size={11} /> : <FaDirections size={11} />} Route BFP → Sensor
              </button>
            </div>
          </Modal.Body>
          );
        })()}
        <Modal.Footer style={{ background: '#0d0d1a', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setShowSensorModal(false)} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '6px', padding: '8px 18px', color: 'rgba(255,255,255,0.7)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>Close</button>
        </Modal.Footer>
      </Modal>

      {/* INCIDENT DETAIL MODAL */}
      <Modal show={showIncidentModal} onHide={() => setShowIncidentModal(false)} size="lg" centered>
        <Modal.Header closeButton style={{ background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#fff' }}>
          <Modal.Title style={{ fontSize: '16px', fontWeight: '600' }}>
            <FaFire className="me-2 text-danger" size={14} /> Incident {selectedIncident?.incident_id}
          </Modal.Title>
        </Modal.Header>
        {selectedIncident && (() => {
          const normalizedStatus = normalizeIncidentStatus(selectedIncident.status);
          const isResolved = normalizedStatus === 'Resolved';
          const isCancelled = normalizedStatus === 'Cancelled';
          const isTerminal = isResolved || isCancelled;
          const resolvedAtText = isResolved ? formatResolvedTime((selectedIncident as any).resolved_at) : '';
          const resolvedByUnit = (selectedIncident as any).resolved_by_unit;

          return (
            <Modal.Body style={{ background: '#0d0d1a', color: '#fff' }}>
              <div style={{ marginBottom: '12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <span style={{ padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', background: selectedIncident.threat_level === 'RED' ? 'rgba(220,53,69,0.25)' : 'rgba(255,193,7,0.25)', color: selectedIncident.threat_level === 'RED' ? '#ff6b6b' : '#ffc107' }}>
                  <FaExclamationTriangle className="me-1" size={9} /> {selectedIncident.threat_level} THREAT
                </span>
                <span style={{
                  padding: '4px 16px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: '700',
                  background: getStatusColor(normalizedStatus) + '40',
                  color: getStatusColor(normalizedStatus),
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}>
                  {isResolved && <FaCheckCircle size={10} />}
                  {isCancelled && <FaTimesCircle size={10} />}
                  {normalizedStatus.toUpperCase()}
                </span>
                {normalizedStatus === 'Verified' && !isTerminal && (
                  <span style={{ padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', background: 'rgba(23,162,184,0.25)', color: '#4dd0e1' }}>
                    <FaShieldAlt className="me-1" size={9} /> VERIFIED
                  </span>
                )}
              </div>

              {isResolved && (
                <div style={{
                  background: 'linear-gradient(135deg, rgba(40,167,69,0.2), rgba(40,167,69,0.08))',
                  border: '1px solid rgba(40,167,69,0.4)',
                  borderRadius: '10px',
                  padding: '14px 18px',
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}>
                  <div style={{
                    width: '42px', height: '42px', borderRadius: '50%',
                    background: 'rgba(40,167,69,0.25)',
                    border: '2px solid rgba(40,167,69,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <FaCheckCircle size={20} style={{ color: '#4dff88' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '15px', fontWeight: '700', color: '#4dff88', marginBottom: '2px' }}>
                      ✅ Incident Resolved
                    </div>
                    {resolvedAtText && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)', fontWeight: '500' }}>
                        Resolved at: {resolvedAtText}
                      </div>
                    )}
                    {resolvedByUnit && (
                      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', fontWeight: '500', marginTop: '2px' }}>
                        Resolved by unit: <strong style={{ color: '#4dd0e1' }}>{resolvedByUnit}</strong>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {isCancelled && (
                <div style={{
                  background: 'linear-gradient(135deg, rgba(108,117,125,0.2), rgba(108,117,125,0.08))',
                  border: '1px solid rgba(108,117,125,0.4)',
                  borderRadius: '10px',
                  padding: '14px 18px',
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}>
                  <div style={{
                    width: '42px', height: '42px', borderRadius: '50%',
                    background: 'rgba(108,117,125,0.25)',
                    border: '2px solid rgba(108,117,125,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <FaTimesCircle size={20} style={{ color: 'rgba(255,255,255,0.7)' }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '15px', fontWeight: '700', color: 'rgba(255,255,255,0.8)', marginBottom: '2px' }}>
                      ❌ Incident Cancelled
                    </div>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', fontWeight: '500' }}>
                      This incident was marked as cancelled or a false alarm.
                    </div>
                  </div>
                </div>
              )}

              <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
                <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                  <FaMapMarkerAlt className="me-2 text-danger" size={11} />
                  <span style={{ color: '#fff' }}>{selectedIncident.location_address || `${selectedIncident.latitude}, ${selectedIncident.longitude}`}</span>
                </div>
                <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                  <FaClock className="me-2" size={11} />
                  <span style={{ color: '#fff' }}>{new Date(selectedIncident.reported_at).toLocaleString()}</span>
                </div>
                <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                  <FaUser className="me-2" size={11} />
                  <span style={{ color: '#fff' }}>Source: {selectedIncident.source}</span>
                </div>
                {selectedIncident.description && (
                  <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', marginTop: '6px', fontWeight: '500' }}>
                    <strong style={{ color: 'rgba(255,255,255,0.8)' }}>Description:</strong> {selectedIncident.description}
                  </div>
                )}
                {selectedIncident.response_time_seconds && (
                  <div style={{ fontSize: '12px', color: '#4dff88', marginTop: '4px', fontWeight: '600' }}>
                    <strong>Response Time:</strong> {formatDuration(selectedIncident.response_time_seconds)}
                  </div>
                )}
              </div>
              <hr style={{ borderColor: 'rgba(255,255,255,0.08)' }} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {normalizedStatus === 'Received' && (
                  <>
                    <button onClick={() => handleFalseAlarm(selectedIncident)} disabled={processing} style={{ background: 'rgba(220,53,69,0.2)', border: '1px solid rgba(220,53,69,0.3)', borderRadius: '6px', padding: '8px 20px', color: '#ff6b6b', fontSize: '13px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {processing ? <FaSpinner className="spin" size={11} /> : <FaTimes size={11} />} False Alarm
                    </button>
                  </>
                )}
                {normalizedStatus === 'Verified' && !isTerminal && (
                  <button onClick={() => setShowDispatchModal(true)} disabled={processing} style={{ background: '#0d6efd', border: 'none', borderRadius: '6px', padding: '8px 20px', color: '#fff', fontSize: '13px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <FaTruck size={11} /> Dispatch Units
                  </button>
                )}
                <button onClick={() => { routeBFPToIncident(selectedIncident); setShowIncidentModal(false); }} disabled={routeLoading} style={{ background: 'rgba(13,110,253,0.15)', border: '1px solid rgba(13,110,253,0.25)', borderRadius: '6px', padding: '8px 20px', color: '#4d9aff', fontSize: '13px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {routeLoading ? <FaSpinner className="spin" size={11} /> : <FaDirections size={11} />} Route BFP → Caller
                </button>
                <button onClick={() => { deleteIncident(selectedIncident); }} disabled={processing} title="Remove from dispatcher map (data preserved for Admin)" style={{ background: 'rgba(220,53,69,0.15)', border: '1px solid rgba(220,53,69,0.25)', borderRadius: '6px', padding: '8px 20px', color: '#ff6b6b', fontSize: '13px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {processing ? <FaSpinner className="spin" size={11} /> : <FaTrash size={11} />} Remove from Map
                </button>
              </div>
            </Modal.Body>
          );
        })()}
        <Modal.Footer style={{ background: '#0d0d1a', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setShowIncidentModal(false)} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '6px', padding: '8px 18px', color: 'rgba(255,255,255,0.7)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>Close</button>
        </Modal.Footer>
      </Modal>

      {/* MOBILE EMERGENCY DETAIL MODAL */}
      <Modal show={showMobileEmergencyModal} onHide={() => setShowMobileEmergencyModal(false)} size="lg" centered>
        <Modal.Header closeButton style={{ background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#fff' }}>
          <Modal.Title style={{ fontSize: '16px', fontWeight: '600' }}>
            <FaPhoneAlt className="me-2 text-danger" size={14} />
            {selectedMobileEmergency?.resolved ? 'Resolved Emergency Call' : selectedMobileEmergency?.verified ? 'Verified Emergency Call' : selectedMobileEmergency?.acknowledged ? 'Emergency Call Details' : '📞 Incoming Emergency Call'}
          </Modal.Title>
        </Modal.Header>
        {selectedMobileEmergency && (
          <Modal.Body style={{ background: '#0d0d1a', color: '#fff' }}>
            <div style={{ marginBottom: '12px' }}>
              <span style={{
                padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', marginRight: '8px',
                background: selectedMobileEmergency.resolved ? 'rgba(40,167,69,0.25)' : selectedMobileEmergency.verified ? 'rgba(23,162,184,0.25)' : selectedMobileEmergency.acknowledged ? 'rgba(40,167,69,0.25)' : 'rgba(220,53,69,0.25)',
                color: selectedMobileEmergency.resolved ? '#4dff88' : selectedMobileEmergency.verified ? '#4dd0e1' : selectedMobileEmergency.acknowledged ? '#4dff88' : '#ff6b6b'
              }}>
                {selectedMobileEmergency.resolved ? '✓ Resolved' : selectedMobileEmergency.verified ? '✓ Verified' : selectedMobileEmergency.acknowledged ? '✓ Acknowledged' : '📞 Incoming Call'}
              </span>
              {selectedMobileEmergency.incident_id && !selectedMobileEmergency.resolved && (
                <span style={{
                  padding: '4px 16px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
                  background: 'rgba(23,162,184,0.25)', color: '#4dd0e1'
                }}>
                  🔥 Incident: {selectedMobileEmergency.incident_id}
                </span>
              )}
            </div>
            <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
              <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', wordBreak: 'break-word', fontWeight: '500' }}>
                <FaUser className="me-2" size={11} />
                <span style={{ color: '#fff' }}>{selectedMobileEmergency.caller_name || 'Unknown Caller'}</span>
              </div>
              <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                <FaPhone className="me-2" size={11} />
                <span style={{ color: '#fff' }}>{selectedMobileEmergency.caller_phone || 'No phone'}</span>
              </div>
              <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                <FaMapMarkerAlt className="me-2 text-danger" size={11} />
                <span style={{ color: '#fff' }}>{selectedMobileEmergency.address || `${selectedMobileEmergency.latitude}, ${selectedMobileEmergency.longitude}`}</span>
              </div>
              <div style={{ fontSize: '13px', marginBottom: '4px', color: 'rgba(255,255,255,0.85)', fontWeight: '500' }}>
                <FaClock className="me-2" size={11} />
                <span style={{ color: '#fff' }}>{new Date(selectedMobileEmergency.timestamp).toLocaleString()}</span>
              </div>
              {selectedMobileEmergency.acknowledged_by_name && (
                <div style={{ fontSize: '12px', color: '#4dff88', marginTop: '4px', fontWeight: '600' }}>
                  <FaCheckCircle className="me-1" size={11} />
                  Answered by: <strong>{selectedMobileEmergency.acknowledged_by_name}</strong>
                </div>
              )}
              {selectedMobileEmergency.verified && selectedMobileEmergency.verified_by_name && (
                <div style={{
                  fontSize: '12px', color: '#4dd0e1', marginTop: '6px', fontWeight: '600',
                  background: 'rgba(23,162,184,0.12)', padding: '6px 10px', borderRadius: '6px',
                  border: '1px solid rgba(23,162,184,0.25)',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaShieldAlt size={11} />
                  Verified by: <strong>{selectedMobileEmergency.verified_by_name}</strong>
                  {selectedMobileEmergency.incident_id && (
                    <span style={{ marginLeft: 'auto', fontWeight: '700' }}>
                      🔥 {selectedMobileEmergency.incident_id}
                    </span>
                  )}
                </div>
              )}
              {selectedMobileEmergency.resolved && selectedMobileEmergency.resolved_by_name && (
                <div style={{
                  fontSize: '12px', color: '#4dff88', marginTop: '6px', fontWeight: '600',
                  background: 'rgba(40,167,69,0.12)', padding: '6px 10px', borderRadius: '6px',
                  border: '1px solid rgba(40,167,69,0.25)',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheckCircle size={11} />
                  Resolved by: <strong>{selectedMobileEmergency.resolved_by_name}</strong>
                  {selectedMobileEmergency.resolved_at && (
                    <span style={{ marginLeft: 'auto', fontWeight: '500', opacity: 0.85 }}>
                      {new Date(selectedMobileEmergency.resolved_at).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
            </div>
            <hr style={{ borderColor: 'rgba(255,255,255,0.08)' }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {!selectedMobileEmergency.acknowledged && (
                <button onClick={() => acknowledgeMobileEmergency(selectedMobileEmergency)} style={{
                  background: '#28a745', border: 'none', borderRadius: '6px',
                  padding: '8px 20px', color: '#fff', fontSize: '13px', fontWeight: '600',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheck size={11} /> Answer
                </button>
              )}

              {selectedMobileEmergency.acknowledged && !selectedMobileEmergency.verified && !selectedMobileEmergency.resolved && (
                <button
                  onClick={() => verifyMobileEmergency(selectedMobileEmergency)}
                  disabled={processing}
                  style={{
                    background: 'linear-gradient(135deg, #17a2b8, #117a8b)',
                    border: 'none', borderRadius: '6px',
                    padding: '8px 20px', color: '#fff',
                    fontSize: '13px', fontWeight: '700',
                    cursor: processing ? 'default' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px',
                    boxShadow: '0 4px 16px rgba(23,162,184,0.35)'
                  }}
                >
                  {processing ? <FaSpinner className="spin" size={11} /> : <FaShieldAlt size={11} />}
                  Verify & Create Incident
                </button>
              )}

              {selectedMobileEmergency.verified && !selectedMobileEmergency.resolved && (
                <div style={{
                  background: 'rgba(23,162,184,0.18)',
                  border: '1px solid rgba(23,162,184,0.35)',
                  borderRadius: '6px', padding: '8px 20px',
                  color: '#4dd0e1', fontSize: '13px', fontWeight: '700',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheckCircle size={11} /> Verified
                  {selectedMobileEmergency.incident_id && (
                    <span style={{ fontWeight: '500', opacity: 0.85 }}>
                      — Incident {selectedMobileEmergency.incident_id}
                    </span>
                  )}
                </div>
              )}

              {selectedMobileEmergency.resolved && (
                <div style={{
                  background: 'rgba(40,167,69,0.18)',
                  border: '1px solid rgba(40,167,69,0.35)',
                  borderRadius: '6px', padding: '8px 20px',
                  color: '#4dff88', fontSize: '13px', fontWeight: '700',
                  display: 'flex', alignItems: 'center', gap: '6px'
                }}>
                  <FaCheckCircle size={11} /> Resolved — marker hidden from map
                </div>
              )}

              <button onClick={() => { routeBFPToMobileEmergency({ lat: selectedMobileEmergency.latitude, lng: selectedMobileEmergency.longitude, name: selectedMobileEmergency.caller_name || 'caller' }); setShowMobileEmergencyModal(false); }} disabled={routeLoading} style={{
                background: 'rgba(13,110,253,0.15)', border: '1px solid rgba(13,110,253,0.25)',
                borderRadius: '6px', padding: '8px 20px', color: '#4d9aff',
                fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                {routeLoading ? <FaSpinner className="spin" size={11} /> : <FaDirections size={11} />} Route BFP → Location
              </button>

              <button onClick={() => deleteMobileEmergency(selectedMobileEmergency)} style={{
                background: 'rgba(220,53,69,0.15)', border: '1px solid rgba(220,53,69,0.25)',
                borderRadius: '6px', padding: '8px 20px', color: '#ff6b6b',
                fontSize: '13px', fontWeight: '600', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                <FaTrash size={11} /> Delete Permanently
              </button>
            </div>
          </Modal.Body>
        )}
        <Modal.Footer style={{ background: '#0d0d1a', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button onClick={() => setShowMobileEmergencyModal(false)} style={{ background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '6px', padding: '8px 18px', color: 'rgba(255,255,255,0.7)', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>Close</button>
        </Modal.Footer>
      </Modal>

      {/* DISPATCH UNITS MODAL */}
      <Modal
        show={showDispatchModal}
        onHide={() => setShowDispatchModal(false)}
        centered
        size="lg"
        contentClassName="dispatch-modal-content"
      >
        <Modal.Header
          closeButton
          closeVariant="white"
          style={{
            background: 'linear-gradient(135deg, #1a1a2e 0%, #16162a 100%)',
            borderBottom: '1px solid rgba(13,110,253,0.25)',
            color: '#fff',
            padding: '20px 26px'
          }}
        >
          <div>
            <Modal.Title style={{ fontSize: '17px', fontWeight: '700', letterSpacing: '0.2px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{
                width: '38px', height: '38px', borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(13,110,253,0.25), rgba(13,110,253,0.1))',
                border: '1px solid rgba(13,110,253,0.35)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <FaTruck size={16} style={{ color: '#4d9aff' }} />
              </span>
              Dispatch Response Units
            </Modal.Title>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginTop: '4px', fontWeight: '500', paddingLeft: '48px' }}>
              Assign available units to incident{' '}
              <span style={{
                color: '#4d9aff', fontWeight: '700', fontFamily: 'monospace',
                background: 'rgba(13,110,253,0.12)', padding: '1px 8px',
                borderRadius: '4px', border: '1px solid rgba(13,110,253,0.2)'
              }}>
                {selectedIncident?.incident_id}
              </span>
            </div>
          </div>
        </Modal.Header>

        <Modal.Body style={{
          background: '#0d0d1a',
          color: '#fff',
          padding: '22px 26px',
          maxHeight: '65vh',
          overflowY: 'auto'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'linear-gradient(135deg, rgba(13,110,253,0.1), rgba(13,110,253,0.04))',
            border: '1px solid rgba(13,110,253,0.2)',
            borderRadius: '10px',
            padding: '12px 18px',
            marginBottom: '18px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div style={{
                width: '32px', height: '32px', borderRadius: '8px',
                background: selectedUnits.length > 0
                  ? 'linear-gradient(135deg, #0d6efd, #0a58ca)'
                  : 'rgba(255,255,255,0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '14px', fontWeight: '800', color: '#fff',
                transition: 'all 0.2s ease'
              }}>
                {selectedUnits.length}
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: '700', color: '#fff', letterSpacing: '0.2px' }}>
                  {selectedUnits.length === 0
                    ? 'No units selected'
                    : `${selectedUnits.length} unit${selectedUnits.length > 1 ? 's' : ''} selected`}
                </div>
                <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500', marginTop: '1px' }}>
                  {availableUnits.length} unit{availableUnits.length !== 1 ? 's' : ''} available for dispatch
                  {!unitsLoaded && ' (loading…)'}
                </div>
              </div>
            </div>
            {selectedUnits.length > 0 && (
              <button
                onClick={() => setSelectedUnits([])}
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  color: 'rgba(255,255,255,0.75)',
                  fontSize: '11px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s ease'
                }}
              >
                <FaTimes size={10} /> Clear selection
              </button>
            )}
          </div>

          {!unitsLoaded && liveAvailableUnits.length === 0 ? (
            <div style={{
              padding: '40px 24px',
              textAlign: 'center',
              background: 'linear-gradient(135deg, rgba(13,110,253,0.06), rgba(13,110,253,0.02))',
              border: '1px solid rgba(13,110,253,0.15)',
              borderRadius: '12px'
            }}>
              <FaSpinner className="spin" size={24} style={{ color: '#4d9aff', marginBottom: '10px' }} />
              <div style={{ fontSize: '13px', fontWeight: '600', color: '#fff', marginBottom: '4px' }}>
                Loading response units…
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>
                Fetching live unit status from the field
              </div>
            </div>
          ) : availableUnits.length === 0 ? (
            <div style={{
              background: 'linear-gradient(135deg, rgba(220,53,69,0.1), rgba(220,53,69,0.04))',
              border: '1px solid rgba(220,53,69,0.25)',
              borderRadius: '12px',
              padding: '32px 24px',
              textAlign: 'center'
            }}>
              <div style={{
                width: '56px', height: '56px', borderRadius: '50%',
                background: 'rgba(220,53,69,0.12)',
                border: '1px solid rgba(220,53,69,0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 14px'
              }}>
                <FaExclamationCircle size={22} style={{ color: '#ff6b6b' }} />
              </div>
              <div style={{ fontSize: '14px', fontWeight: '700', color: '#ff6b6b', marginBottom: '4px' }}>
                No Units Available
              </div>
              <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.55)', fontWeight: '500' }}>
                All response units are currently deployed, off-duty, or offline.
                Make sure the unit's mobile app is running — it pings the server every 45 seconds while active.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {availableUnits.map(unit => {
                if (!hasValidCoords(unit) || !selectedIncident || !hasValidCoords(selectedIncident)) {
                  return null;
                }
                const route = unitRoutes[unit.unit_id];
                const distKm = route?.distanceKm ?? calculateDistance(
                  selectedIncident.latitude, selectedIncident.longitude,
                  unit.latitude, unit.longitude
                );
                const etaMin = route?.etaMinutes ?? Math.max(1, Math.round(distKm / 40 * 60));
                const distText = route?.distanceText ?? `${distKm.toFixed(2)} km`;
                const etaText = route?.etaText ?? `~${etaMin} min`;

                const isSelected = selectedUnits.includes(unit.unit_id);

                return (
                  <div
                    key={unit.unit_id}
                    className="dispatch-unit-card"
                    onClick={() => {
                      if (isSelected) {
                        setSelectedUnits(selectedUnits.filter(id => id !== unit.unit_id));
                      } else {
                        setSelectedUnits([...selectedUnits, unit.unit_id]);
                      }
                    }}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '16px',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(13,110,253,0.15), rgba(13,110,253,0.05))'
                        : 'rgba(255,255,255,0.04)',
                      border: `1.5px solid ${isSelected ? 'rgba(13,110,253,0.5)' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: '12px',
                      padding: '16px 20px',
                      cursor: 'pointer',
                      transition: 'all 0.18s ease',
                      boxShadow: isSelected ? '0 4px 20px rgba(13,110,253,0.15)' : 'none'
                    }}
                  >
                    <div style={{
                      width: '22px', height: '22px', borderRadius: '6px',
                      border: `2px solid ${isSelected ? '#0d6efd' : 'rgba(255,255,255,0.2)'}`,
                      background: isSelected ? '#0d6efd' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.15s ease'
                    }}>
                      {isSelected && <FaCheck size={11} style={{ color: '#fff' }} />}
                    </div>

                    <div style={{
                      width: '48px', height: '48px', borderRadius: '12px',
                      background: isSelected
                        ? 'linear-gradient(135deg, rgba(13,110,253,0.25), rgba(13,110,253,0.1))'
                        : 'rgba(40,167,69,0.12)',
                      border: `1px solid ${isSelected ? 'rgba(13,110,253,0.4)' : 'rgba(40,167,69,0.25)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      <FaTruck size={20} style={{ color: isSelected ? '#4d9aff' : '#4dff88' }} />
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '15px', fontWeight: '700', color: '#fff', letterSpacing: '0.1px' }}>
                          {unit.unit_name}
                        </span>
                        <span style={{
                          fontSize: '10px', fontWeight: '700',
                          color: 'rgba(255,255,255,0.7)',
                          background: 'rgba(255,255,255,0.08)',
                          padding: '2px 8px', borderRadius: '4px',
                          letterSpacing: '0.5px', fontFamily: 'monospace'
                        }}>
                          {unit.unit_code}
                        </span>
                        <span style={{
                          fontSize: '10px', fontWeight: '700',
                          color: '#4dff88',
                          background: 'rgba(40,167,69,0.15)',
                          border: '1px solid rgba(40,167,69,0.3)',
                          padding: '2px 8px', borderRadius: '10px',
                          letterSpacing: '0.3px',
                          display: 'inline-flex', alignItems: 'center', gap: '4px'
                        }}>
                          <span style={{
                            width: '5px', height: '5px', borderRadius: '50%',
                            background: '#4dff88', display: 'inline-block'
                          }} />
                          AVAILABLE
                        </span>
                      </div>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: '14px',
                        marginTop: '6px', flexWrap: 'wrap'
                      }}>
                        <span style={{
                          fontSize: '12px', color: 'rgba(255,255,255,0.65)',
                          fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px'
                        }}>
                          <FaRoad size={10} style={{ color: 'rgba(255,255,255,0.4)' }} />
                          <span style={{ color: '#4d9aff', fontWeight: '700' }}>{distText}</span>
                          <span style={{ color: 'rgba(255,255,255,0.4)' }}>away</span>
                        </span>
                        <span style={{
                          fontSize: '12px', color: 'rgba(255,255,255,0.65)',
                          fontWeight: '500', display: 'flex', alignItems: 'center', gap: '5px'
                        }}>
                          <FaClockIcon size={10} style={{ color: 'rgba(255,255,255,0.4)' }} />
                          <span style={{ color: '#ffc107', fontWeight: '700' }}>{etaText}</span>
                          <span style={{ color: 'rgba(255,255,255,0.4)' }}>ETA</span>
                        </span>
                      </div>
                    </div>

                    {isSelected && (
                      <div style={{
                        position: 'absolute',
                        top: '12px',
                        right: '16px',
                        fontSize: '9px',
                        fontWeight: '800',
                        letterSpacing: '0.8px',
                        color: '#4d9aff',
                        background: 'rgba(13,110,253,0.2)',
                        border: '1px solid rgba(13,110,253,0.4)',
                        padding: '2px 8px',
                        borderRadius: '10px'
                      }}>
                        SELECTED
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Modal.Body>

        <Modal.Footer style={{
          background: 'linear-gradient(135deg, #16162a 0%, #1a1a2e 100%)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '16px 26px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontWeight: '500' }}>
            {selectedUnits.length > 0 ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <FaCheckCircle size={11} style={{ color: '#4dff88' }} />
                Ready to dispatch to <strong style={{ color: '#4d9aff' }}>{selectedIncident?.incident_id}</strong>
              </span>
            ) : (
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <FaExclamationCircle size={11} style={{ color: 'rgba(255,255,255,0.4)' }} />
                Select at least one unit to continue
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => setShowDispatchModal(false)}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '8px',
                padding: '10px 22px',
                color: 'rgba(255,255,255,0.8)',
                fontSize: '13px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDispatchUnits}
              disabled={selectedUnits.length === 0 || processing}
              style={{
                background: selectedUnits.length === 0 || processing
                  ? 'rgba(255,255,255,0.06)'
                  : 'linear-gradient(135deg, #0d6efd, #0a58ca)',
                border: selectedUnits.length === 0 || processing
                  ? '1px solid rgba(255,255,255,0.08)'
                  : '1px solid rgba(13,110,253,0.5)',
                borderRadius: '8px',
                padding: '10px 26px',
                color: selectedUnits.length === 0 || processing
                  ? 'rgba(255,255,255,0.3)'
                  : '#fff',
                fontSize: '13px',
                fontWeight: '700',
                cursor: selectedUnits.length === 0 || processing ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: selectedUnits.length === 0 || processing
                  ? 'none'
                  : '0 4px 16px rgba(13,110,253,0.4)',
                letterSpacing: '0.2px',
                transition: 'all 0.15s ease'
              }}
            >
              {processing ? (
                <>
                  <FaSpinner className="spin" size={12} />
                  Dispatching...
                </>
              ) : (
                <>
                  <FaTruck size={12} />
                  Dispatch {selectedUnits.length > 0 && `(${selectedUnits.length})`}
                </>
              )}
            </button>
          </div>
        </Modal.Footer>
      </Modal>

      {/* MAP CONTAINER */}
      <div style={{ position: 'fixed', top: '56px', left: 0, right: 0, bottom: 0, background: '#1a1a2e' }}>
        {hasApiKey ? (
          <LoadScript
            googleMapsApiKey={googleMapsApiKey}
            loading="async"
            libraries={GOOGLE_MAPS_LIBRARIES}
            onLoad={handleLoadScript}
            onError={handleLoadScriptError}
          >
            <GoogleMap
              mapContainerStyle={mapContainerStyle}
              center={mapCenter}
              zoom={mapZoom}
              options={mapOptions}
              onLoad={handleMapLoad}
              onClick={handleMapClick}
              onZoomChanged={() => { if (mapRef.current) setMapZoom(mapRef.current.getZoom() || 14); }}
            >
              {mapLoaded && window.google?.maps && (
                <>
                  <Marker
                    position={{ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng }}
                    icon={{
                      path: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
                      fillColor: '#dc3545', fillOpacity: 1,
                      strokeColor: '#ffffff', strokeWeight: 2, scale: 1.5,
                    }}
                    onClick={() => { setShowFireStationInfo(true); setTimeout(() => setShowFireStationInfo(false), 5000); }}
                  />

                  {showFireStationInfo && (
                    <InfoWindow
                      position={{ lat: FIRE_STATION_LOCATION.lat, lng: FIRE_STATION_LOCATION.lng }}
                      onCloseClick={() => setShowFireStationInfo(false)}
                      options={
                        window.google?.maps?.Size
                          ? { pixelOffset: new window.google.maps.Size(0, -10), maxWidth: 280 }
                          : { maxWidth: 280 }
                      }
                    >
                      <div style={{ color: '#000', padding: '6px', textAlign: 'center', maxWidth: '220px', fontSize: '13px', fontWeight: '500' }}>
                        <strong style={{ fontSize: '13px' }}>🚒 Gonzaga Fire Station (BFP)</strong><br />
                        <span style={{ fontSize: '12px' }}>Poblacion, Gonzaga, Cagayan</span><br />
                        <span style={{ fontSize: '12px' }}>Philippines</span>
                      </div>
                    </InfoWindow>
                  )}

                  {visibleIncidents.map((incident) => (
                    <Marker
                      key={incident.incident_id}
                      position={{ lat: incident.latitude, lng: incident.longitude }}
                      icon={getIncidentIcon(incident.threat_level || 'YELLOW', incident.status)}
                      onClick={() => {
                        setSelectedMarker({ type: 'incident', data: incident });
                        setSelectedIncident(incident);
                        setShowIncidentModal(true);
                      }}
                    />
                  ))}

                  {visibleMobileEmergencies.map((emergency) => (
                    <Marker
                      key={`mobile-${emergency.id}`}
                      position={{ lat: emergency.latitude, lng: emergency.longitude }}
                      icon={getMobileEmergencyIcon(emergency.acknowledged, emergency.verified)}
                      animation={
                        !emergency.acknowledged
                          ? google.maps.Animation.BOUNCE
                          : undefined
                      }
                      onClick={() => {
                        setSelectedMobileEmergency(emergency);
                        setShowMobileEmergencyModal(true);
                        if (emergency.verified) {
                          toast.success(`✓ Verified emergency from ${emergency.caller_name || 'Unknown Caller'}`, { duration: 3000 });
                        } else if (!emergency.acknowledged) {
                          toast.error(`📞 INCOMING EMERGENCY CALL from ${emergency.caller_name || 'Unknown Caller'}!`, { duration: 8000 });
                        } else {
                          toast(`📍 ${emergency.caller_name || 'Unknown Caller'} - Emergency call acknowledged`, { duration: 3000 });
                        }
                      }}
                    />
                  ))}

                  {safeSelectedMarker && (
                    <InfoWindow
                      position={{ lat: safeSelectedMarker.data.latitude, lng: safeSelectedMarker.data.longitude }}
                      onCloseClick={() => setSelectedMarker(null)}
                      options={
                        window.google?.maps?.Size
                          ? { pixelOffset: new window.google.maps.Size(0, -10), maxWidth: 280 }
                          : { maxWidth: 280 }
                      }
                    >
                      <div style={{
                        color: '#1a1a2e', padding: '8px 12px', maxWidth: '260px',
                        backgroundColor: '#ffffff', borderRadius: '8px',
                        fontFamily: 'system-ui, -apple-system, sans-serif',
                        fontSize: '13px', fontWeight: '500', lineHeight: '1.5'
                      }}>
                        {safeSelectedMarker.type === 'incident' && (() => {
                          const nStatus = normalizeIncidentStatus(safeSelectedMarker.data.status);
                          return (
                            <>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                                <span style={{
                                  background: nStatus === 'Verified' ? '#17a2b8' : nStatus === 'Resolved' ? '#28a745' : nStatus === 'Cancelled' ? '#6c757d' : safeSelectedMarker.data.threat_level === 'RED' ? '#dc3545' : '#ffc107',
                                  color: '#ffffff', padding: '2px 10px', borderRadius: '12px',
                                  fontSize: '11px', fontWeight: '700', letterSpacing: '0.5px'
                                }}>{nStatus === 'Verified' ? 'VERIFIED' : nStatus === 'Resolved' ? 'RESOLVED' : nStatus === 'Cancelled' ? 'CANCELLED' : safeSelectedMarker.data.threat_level}</span>
                                <span style={{ fontSize: '13px', fontWeight: '700', color: '#1a1a2e' }}>{safeSelectedMarker.data.incident_id}</span>
                              </div>
                              <div style={{ fontSize: '13px', color: '#333333', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '500' }}>
                                <span style={{ fontWeight: '700', color: '#1a1a2e' }}>Status:</span>
                                <span style={{ color: getStatusColor(nStatus), fontWeight: '600' }}>{nStatus}</span>
                              </div>
                              {safeSelectedMarker.data.location_address && (
                                <div style={{ fontSize: '12px', color: '#555555', marginBottom: '6px', wordBreak: 'break-word', fontWeight: '500' }}>
                                  <span style={{ fontWeight: '700', color: '#1a1a2e' }}>📍</span> {safeSelectedMarker.data.location_address}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                                <button onClick={() => { setSelectedIncident(safeSelectedMarker.data); setShowIncidentModal(true); setSelectedMarker(null); }}
                                  style={{ background: '#0d6efd', border: 'none', borderRadius: '6px', padding: '5px 16px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', fontWeight: '700' }}>
                                  View
                                </button>
                                <button onClick={() => { routeBFPToIncident(safeSelectedMarker.data); setSelectedMarker(null); }} disabled={routeLoading}
                                  style={{ background: '#28a745', border: 'none', borderRadius: '6px', padding: '5px 16px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '700' }}>
                                  {routeLoading ? <FaSpinner className="spin" size={10} /> : <FaDirections size={10} />} Route
                                </button>
                              </div>
                            </>
                          );
                        })()}
                        {safeSelectedMarker.type === 'unit' && (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                              <span style={{ fontSize: '14px' }}>🚒</span>
                              <span style={{ fontSize: '13px', fontWeight: '700', color: '#1a1a2e' }}>{safeSelectedMarker.data.unit_name}</span>
                            </div>
                            <div style={{ fontSize: '13px', color: '#333333', marginBottom: '4px', fontWeight: '500' }}>
                              <span style={{ fontWeight: '700', color: '#1a1a2e' }}>Status:</span>{' '}
                              <span style={{
                                color: safeSelectedMarker.data.status === 'Available' ? '#28a745' :
                                  safeSelectedMarker.data.status === 'Dispatched' ? '#0d6efd' :
                                    safeSelectedMarker.data.status === 'EnRoute' ? '#fd7e14' :
                                      safeSelectedMarker.data.status === 'OnScene' ? '#dc3545' : '#6c757d',
                                fontWeight: '600'
                              }}>{safeSelectedMarker.data.status}</span>
                            </div>
                            <div style={{ fontSize: '12px', color: '#555555', marginBottom: '4px', fontWeight: '500' }}>
                              📍 {safeSelectedMarker.data.latitude.toFixed(6)}, {safeSelectedMarker.data.longitude.toFixed(6)}
                            </div>
                            <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px', fontStyle: 'italic' }}>
                              Live GPS from device
                            </div>
                            {selectedIncident && hasValidCoords(selectedIncident) && (
                              <button onClick={() => { routeUnitToIncident(safeSelectedMarker.data, selectedIncident); setSelectedMarker(null); }} disabled={routeLoading}
                                style={{ width: '100%', marginTop: '6px', background: '#17a2b8', border: 'none', borderRadius: '6px', padding: '5px 8px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', fontWeight: '700' }}>
                                {routeLoading ? <FaSpinner className="spin" size={10} /> : <FaDirections size={10} />} Route to Caller
                              </button>
                            )}
                          </>
                        )}
                        {safeSelectedMarker.type === 'sensor' && (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                              <span style={{ fontSize: '14px' }}>📡</span>
                              <span style={{ fontSize: '13px', fontWeight: '700', color: '#1a1a2e' }}>{safeSelectedMarker.data.sensor_type}</span>
                            </div>

                            {safeSelectedMarker.data.location_name && (
                              <div style={{
                                fontSize: '13px',
                                color: '#1a1a2e',
                                marginBottom: '4px',
                                fontWeight: '700',
                                lineHeight: '1.3',
                              }}>
                                {safeSelectedMarker.data.location_name}
                              </div>
                            )}

                            {(safeSelectedMarker.data.building ||
                              safeSelectedMarker.data.room ||
                              safeSelectedMarker.data.floor) && (
                                <div style={{
                                  fontSize: '11px',
                                  color: '#666',
                                  marginBottom: '6px',
                                  fontWeight: '500',
                                }}>
                                  {[
                                    safeSelectedMarker.data.building,
                                    safeSelectedMarker.data.room,
                                    safeSelectedMarker.data.floor,
                                  ].filter(Boolean).join(' • ')}
                                </div>
                              )}

                            {!safeSelectedMarker.data.location_name && (
                              <div style={{ fontSize: '12px', color: '#555555', marginBottom: '4px', fontWeight: '500' }}>
                                📍 {safeSelectedMarker.data.location}
                              </div>
                            )}

                            <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px', fontWeight: '500', fontFamily: 'monospace' }}>
                              {safeSelectedMarker.data.latitude.toFixed(6)}, {safeSelectedMarker.data.longitude.toFixed(6)}
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                              {safeSelectedMarker.data.verified ? (
                                <span style={{ background: '#0d6efd', color: '#ffffff', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>✓ VERIFIED</span>
                              ) : safeSelectedMarker.data.dispatcher_acknowledged ? (
                                <span style={{ background: '#ffc107', color: '#1a1a2e', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>ACKNOWLEDGED</span>
                              ) : safeSelectedMarker.data.threat_level === 'RED' ? (
                                <span style={{ background: '#dc3545', color: '#ffffff', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>🔥 FLAME DETECTED</span>
                              ) : safeSelectedMarker.data.threat_level === 'YELLOW' ? (
                                <span style={{ background: '#ffc107', color: '#1a1a2e', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>⚠️ GAS / SMOKE</span>
                              ) : (
                                <span style={{ background: '#28a745', color: '#ffffff', padding: '2px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: '700' }}>● ONLINE</span>
                              )}
                            </div>

                            <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                              <button onClick={() => { setSelectedSensor(safeSelectedMarker.data); setShowSensorModal(true); setSelectedMarker(null); }}
                                style={{ flex: 1, background: '#0d6efd', border: 'none', borderRadius: '6px', padding: '5px 10px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', fontWeight: '700' }}>
                                View
                              </button>
                              {!safeSelectedMarker.data.dispatcher_acknowledged && !safeSelectedMarker.data.verified && (
                                <button onClick={() => { acknowledgeSensor(safeSelectedMarker.data); setSelectedMarker(null); }}
                                  style={{ flex: 1, background: '#ffc107', border: 'none', borderRadius: '6px', padding: '5px 10px', color: '#1a1a2e', fontSize: '12px', cursor: 'pointer', fontWeight: '700' }}>
                                  Acknowledge
                                </button>
                              )}
                              {!safeSelectedMarker.data.verified && (
                                <button onClick={() => { verifySensorAndCreateIncident(safeSelectedMarker.data); setSelectedMarker(null); }} disabled={processing}
                                  style={{ flex: 1, background: '#17a2b8', border: 'none', borderRadius: '6px', padding: '5px 10px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                                  {processing ? <FaSpinner className="spin" size={10} /> : <FaShieldAlt size={10} />} Verify
                                </button>
                              )}
                            </div>
                          </>
                        )}
                        {safeSelectedMarker.type === 'mobileEmergency' && (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                              <span style={{ fontSize: '14px' }}>
                                {safeSelectedMarker.data.resolved ? '✓' : safeSelectedMarker.data.verified ? '🛡️' : safeSelectedMarker.data.acknowledged ? '✓' : '📞'}
                              </span>
                              <span style={{
                                fontSize: '13px', fontWeight: '700',
                                color: safeSelectedMarker.data.resolved ? '#28a745' : safeSelectedMarker.data.verified ? '#17a2b8' : safeSelectedMarker.data.acknowledged ? '#28a745' : '#dc3545'
                              }}>
                                {safeSelectedMarker.data.resolved ? 'Resolved' : safeSelectedMarker.data.verified ? 'Verified' : safeSelectedMarker.data.acknowledged ? 'Acknowledged' : 'Incoming Call'}
                              </span>
                            </div>
                            <div style={{ fontSize: '12px', color: '#555555', marginBottom: '4px', fontWeight: '500' }}>
                              👤 {safeSelectedMarker.data.caller_name || 'Unknown Caller'}
                            </div>
                            <div style={{ fontSize: '12px', color: '#555555', marginBottom: '4px', fontWeight: '500' }}>
                              📞 {safeSelectedMarker.data.caller_phone || 'No phone'}
                            </div>
                            {safeSelectedMarker.data.incident_id && !safeSelectedMarker.data.resolved && (
                              <div style={{ fontSize: '12px', color: '#17a2b8', marginBottom: '4px', fontWeight: '700' }}>
                                🔥 Incident: {safeSelectedMarker.data.incident_id}
                              </div>
                            )}
                            <button onClick={() => { setSelectedMobileEmergency(safeSelectedMarker.data); setShowMobileEmergencyModal(true); setSelectedMarker(null); }}
                              style={{ width: '100%', marginTop: '6px', background: '#0d6efd', border: 'none', borderRadius: '6px', padding: '5px 8px', color: '#ffffff', fontSize: '12px', cursor: 'pointer', fontWeight: '700' }}>
                              View Details
                            </button>
                          </>
                        )}
                      </div>
                    </InfoWindow>
                  )}
                </>
              )}
            </GoogleMap>
          </LoadScript>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            background: '#0d0d1a',
            color: '#fff'
          }}>
            <div style={{ textAlign: 'center', maxWidth: '440px', padding: '24px' }}>
              <FaExclamationTriangle size={40} className="text-warning mb-3" />
              <h5 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '12px' }}>
                Google Maps API Key Required
              </h5>
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '14px', fontWeight: '500', lineHeight: '1.6', marginBottom: '14px' }}>
                The map cannot be displayed because the Google Maps API key is missing.
                Please ensure the <code style={{ color: '#4d9aff', background: 'rgba(13,110,253,0.15)', padding: '1px 6px', borderRadius: '4px' }}>VITE_GOOGLE_MAPS_API_KEY</code> environment
                variable is correctly set in your <code style={{ color: '#4d9aff', background: 'rgba(13,110,253,0.15)', padding: '1px 6px', borderRadius: '4px' }}>.env</code> file.
              </p>
              <div style={{
                background: 'rgba(220,53,69,0.1)',
                border: '1px solid rgba(220,53,69,0.3)',
                borderRadius: '10px',
                padding: '14px 18px',
                textAlign: 'left',
                fontSize: '12px',
                color: 'rgba(255,255,255,0.75)',
                fontWeight: '500',
                lineHeight: '1.7'
              }}>
                <div style={{ fontWeight: '700', color: '#ff6b6b', marginBottom: '6px', fontSize: '13px' }}>
                  ⚠️ Also verify in Google Cloud Console:
                </div>
                <div>• <strong>Maps JavaScript API</strong> is enabled on your project</div>
                <div>• Billing is active on the linked Google Cloud project</div>
                <div>• The key's <strong>API restrictions</strong> allow "Maps JavaScript API"</div>
                <div>• The key's <strong>HTTP referrer</strong> list includes your domain (e.g., <code style={{ color: '#4d9aff' }}>http://localhost:5173/*</code>)</div>
              </div>
            </div>
          </div>
        )}

        {showRoute && routeData && routeOrigin && routeDestination && (
          <div
            ref={panelRef}
            style={{
              position: 'fixed', top: panelPosition.y, left: panelPosition.x,
              backgroundColor: 'rgba(13,13,26,0.96)', backdropFilter: 'blur(16px)',
              borderRadius: '14px', minWidth: '340px', maxWidth: '400px',
              zIndex: 9997, color: '#fff',
              border: `1px solid ${isDragging ? 'rgba(13,110,253,0.4)' : 'rgba(255,255,255,0.08)'}`,
              boxShadow: isDragging ? '0 16px 64px rgba(0,0,0,0.7)' : '0 8px 32px rgba(0,0,0,0.5)',
              overflow: 'hidden', maxHeight: 'calc(100vh - 200px)', overflowY: 'auto',
              cursor: isDragging ? 'grabbing' : 'default',
              transition: isDragging ? 'none' : 'box-shadow 0.3s ease', userSelect: 'none'
            }}
          >
            <div
              onMouseDown={handleMouseDown}
              style={{
                background: 'linear-gradient(135deg, #0d6efd, #0a58ca)',
                padding: '12px 18px', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center', cursor: 'grab'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FaArrowsAlt size={12} style={{ color: 'rgba(255,255,255,0.6)' }} />
                <FaRoute size={14} style={{ color: 'rgba(255,255,255,0.9)' }} />
                <span style={{ fontWeight: '700', fontSize: '13px', letterSpacing: '0.2px' }}>
                  {routeDestination.name.includes('Caller') ? 'BFP → Caller' :
                    routeDestination.name.includes('Sensor') ? 'BFP → Sensor' :
                      routeDestination.name.includes('Emergency') ? 'BFP → Emergency' : 'Route'}
                </span>
              </div>
              <button onClick={clearRoute} style={{
                background: 'rgba(255,255,255,0.15)', border: 'none',
                borderRadius: '14px', padding: '3px 14px', color: '#fff',
                fontSize: '11px', cursor: 'pointer', fontWeight: '600'
              }}>
                <FaStop size={9} className="me-1" /> Clear
              </button>
            </div>

            <div style={{ padding: '14px 18px 18px' }}>
              <div style={{ marginBottom: '8px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: '#ff6b6b', letterSpacing: '0.3px', textTransform: 'uppercase', marginBottom: '2px' }}>
                  <FaLocationArrow size={10} className="me-1" /> FROM — BFP FIRE STATION
                </div>
                <div style={{ background: 'rgba(220,53,69,0.08)', borderRadius: '6px', padding: '8px 14px', borderLeft: '2px solid #dc3545' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#fff' }}>Gonzaga Fire Station (BFP)</div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', fontWeight: '500' }}>
                    {FIRE_STATION_LOCATION.lat.toFixed(5)}, {FIRE_STATION_LOCATION.lng.toFixed(5)}
                  </div>
                </div>
              </div>

              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.15)', margin: '-2px 0 6px 0', fontSize: '14px' }}>
                <FaArrowDown />
              </div>

              <div style={{ marginBottom: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: '700', color: '#4dff88', letterSpacing: '0.3px', textTransform: 'uppercase', marginBottom: '2px' }}>
                  <FaFlag size={10} className="me-1" /> TO — {routeDestination.name.includes('Emergency') ? 'EMERGENCY LOCATION' : 'CALLER LOCATION'}
                </div>
                <div style={{ background: 'rgba(40,167,69,0.08)', borderRadius: '6px', padding: '8px 14px', borderLeft: '2px solid #28a745' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: '#fff' }}>
                    {routeDestination.name.length > 35 ? routeDestination.name.substring(0, 35) + '...' : routeDestination.name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', fontWeight: '500' }}>
                    {routeDestination.lat.toFixed(5)}, {routeDestination.lng.toFixed(5)}
                  </div>
                </div>
              </div>

              <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)', margin: '0 0 10px 0' }} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
                {[
                  { label: 'Distance', value: routeData.distance_text, icon: FaRoad, color: '#4d9aff' },
                  { label: 'ETA', value: routeData.duration_text, icon: FaClockIcon, color: '#ffc107' },
                  { label: 'Points', value: routeData.route.length, icon: null, color: '#4dd0e1', custom: '📍' },
                ].map((stat, idx) => (
                  <div key={idx} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '6px', padding: '8px 4px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
                    {stat.icon ? <stat.icon size={12} style={{ color: stat.color, display: 'block', margin: '0 auto 2px' }} /> : <span style={{ fontSize: '14px', display: 'block', margin: '0 auto 1px' }}>{stat.custom}</span>}
                    <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', fontWeight: '600' }}>{stat.label}</div>
                    <div style={{ fontWeight: '700', fontSize: '13px', color: stat.color }}>{stat.value}</div>
                  </div>
                ))}
              </div>

              {routeError && (
                <div style={{ marginTop: '8px', padding: '6px 12px', background: 'rgba(220,53,69,0.12)', borderRadius: '4px', border: '1px solid rgba(220,53,69,0.2)', fontSize: '12px', color: '#ff6b6b', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '500' }}>
                  <FaExclamationCircle size={10} /> {routeError}
                </div>
              )}
            </div>
          </div>
        )}

        {/* LEGEND */}
        <div style={{
          position: 'absolute', bottom: 16, left: 16,
          background: 'rgba(13,13,26,0.92)', backdropFilter: 'blur(12px)',
          padding: '12px 16px', borderRadius: '10px', zIndex: 1000,
          fontSize: '11px', minWidth: '220px',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
        }}>
          <div style={{
            display: 'flex', alignItems: 'center',
            marginBottom: '8px', paddingBottom: '6px',
            borderBottom: '1px solid rgba(255,255,255,0.06)'
          }}>
            <FaMapMarkerAlt className="me-2 text-info" size={9} />
            <span style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.3px', color: 'rgba(255,255,255,0.7)' }}>LEGEND</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 14px' }}>
            {[
              { color: '#dc3545', label: 'BFP Station', shape: 'polygon' },
              { color: '#ff4444', label: 'Incoming Call', shape: 'circle', pulse: true, call: true },
              { color: '#28a745', label: 'Acknowledged', shape: 'circle', call: true },
              { color: '#17a2b8', label: 'Verified', shape: 'circle', call: true },
              { color: '#dc3545', label: 'Flame (RED)', shape: 'circle', pulse: true },
              { color: '#ffc107', label: 'Gas / Smoke (YELLOW)', shape: 'circle' },
              { color: '#0d6efd', label: 'Sensor Verified', shape: 'circle' },
              { color: '#4285F4', label: 'My Location', shape: 'circle', border: true },
              { color: '#0d6efd', label: 'Route', shape: 'line' },
              { color: '#4dff88', label: 'Active Voice Call', shape: 'circle', pulse: true },

              ...(onlineUnitStatuses.size > 0
                ? ([
                  { status: 'Dispatched', color: '#007bff', label: 'Dispatched Unit', pulse: false },
                  { status: 'EnRoute', color: '#17a2b8', label: 'En Route Unit', pulse: true },
                  { status: 'OnScene', color: '#fd7e14', label: 'On Scene Unit', pulse: false },
                ] as const)
                  .filter(item => onlineUnitStatuses.has(item.status))
                  .map(item => ({
                    color: item.color,
                    label: item.label,
                    shape: 'truck' as const,
                    pulse: item.pulse,
                  }))
                : []),
            ].map((item: any, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center' }}>
                {item.shape === 'truck' ? (
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: '7px',
                    flexShrink: 0,
                    width: '14px',
                    height: '14px',
                  }}>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill={item.color}
                      style={{
                        filter: item.pulse ? 'drop-shadow(0 0 4px rgba(23,162,184,0.7))' : 'drop-shadow(0 0 2px rgba(0,0,0,0.4))',
                        animation: item.pulse ? 'pulse-glow 1.5s infinite' : 'none',
                      }}
                    >
                      <path d={FIRE_TRUCK_PATH} />
                    </svg>
                  </span>
                ) : (
                  <span style={{
                    width: item.shape === 'line' ? '16px' : '9px',
                    height: item.shape === 'line' ? '3px' : '9px',
                    borderRadius: item.shape === 'circle' ? '50%' : item.shape === 'polygon' ? '2px' : '2px',
                    backgroundColor: item.color,
                    display: 'inline-block',
                    marginRight: '7px',
                    flexShrink: 0,
                    ...(item.border ? { border: '2px solid #fff', boxShadow: '0 0 8px rgba(66,133,244,0.3)' } : {}),
                    ...(item.pulse ? { animation: 'pulse-glow 1.5s infinite' } : {}),
                    ...(item.shape === 'polygon' ? { clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' } : {}),
                    ...(item.call ? { width: '7px', height: '7px', border: '2px solid rgba(255,255,255,0.6)', boxShadow: '0 0 12px rgba(40,167,69,0.4)' } : {})
                  }} />
                )}
                <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '10px', fontWeight: '500' }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes fadeInScale { from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
        @keyframes pulse-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(220,53,69,0.4); } 50% { box-shadow: 0 0 20px 4px rgba(220,53,69,0.15); } }
        @keyframes pulse-glow-fast { 0%, 100% { box-shadow: 0 0 0 0 rgba(255,0,0,0.5); } 50% { box-shadow: 0 0 30px 8px rgba(255,0,0,0.15); } }
        @keyframes pulse-glow-yellow {
          0%, 100% { box-shadow: 0 24px 80px rgba(0,0,0,0.7), 0 0 60px rgba(255,193,7,0.4); }
          50%      { box-shadow: 0 24px 80px rgba(0,0,0,0.7), 0 0 80px rgba(255,193,7,0.7); }
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
        @keyframes badge-pop {
          0%   { transform: scale(1);   box-shadow: 0 0 0 0 currentColor; }
          40%  { transform: scale(1.18); box-shadow: 0 0 12px 3px currentColor; }
          100% { transform: scale(1);   box-shadow: 0 0 0 0 currentColor; }
        }
        @keyframes latency-pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.4; }
        }
        @keyframes station-alarm-pulse {
          0%, 100% { box-shadow: 0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08), 0 0 60px rgba(220,53,69,0.3); }
          50%      { box-shadow: 0 24px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.12), 0 0 80px rgba(220,53,69,0.5); }
        }
        @keyframes alarm-dot-blink {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.8); }
        }
        @keyframes alarm-icon-pulse {
          0%, 100% { transform: scale(1); border-color: rgba(220,53,69,0.4); }
          50%      { transform: scale(1.05); border-color: rgba(220,53,69,0.7); }
        }
        .spin { animation: spin 1s linear infinite; }

        .dispatcher-geomap {
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          text-rendering: optimizeLegibility;
        }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: rgba(255,255,255,0.02); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

        .modal-content { background: #0d0d1a !important; border: 1px solid rgba(255,255,255,0.08) !important; }
        .modal-header { border-bottom: 1px solid rgba(255,255,255,0.08) !important; }
        .modal-footer { border-top: 1px solid rgba(255,255,255,0.08) !important; }
        .btn-close { filter: brightness(0) invert(1) !important; }

        .form-check-input { background-color: rgba(255,255,255,0.08) !important; border-color: rgba(255,255,255,0.15) !important; }
        .form-check-input:checked { background-color: #0d6efd !important; border-color: #0d6efd !important; }
        .form-check-label { color: #fff !important; font-weight: 500 !important; }

        .gm-style-iw { color: #000 !important; }
        .gm-style .gm-style-iw-c { border-radius: 10px !important; }

        .dispatch-modal-content {
          background: #0d0d1a !important;
          border: 1px solid rgba(255,255,255,0.1) !important;
          border-radius: 16px !important;
          overflow: hidden !important;
          box-shadow: 0 24px 80px rgba(0,0,0,0.8) !important;
        }

        .dispatch-unit-card:hover {
          border-color: rgba(13,110,253,0.35) !important;
          background: rgba(13,110,253,0.06) !important;
          transform: translateY(-1px);
        }

        select {
          background-color: rgba(255,255,255,0.12) !important;
          color: #ffffff !important;
          border: 1px solid rgba(255,255,255,0.25) !important;
          border-radius: 6px !important;
          padding: 6px 30px 6px 12px !important;
          font-size: 12px !important;
          font-weight: 600 !important;
          cursor: pointer !important;
          outline: none !important;
          appearance: none !important;
          -webkit-appearance: none !important;
          -moz-appearance: none !important;
          background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3e%3cpath d='M7 10l5 5 5-5z'/%3e%3c/svg%3e") !important;
          background-repeat: no-repeat !important;
          background-position: right 8px center !important;
          background-size: 14px !important;
        }

        select:focus {
          border-color: rgba(13,110,253,0.6) !important;
          box-shadow: 0 0 0 2px rgba(13,110,253,0.2) !important;
        }

        select option {
          background-color: #1a1a2e !important;
          color: #ffffff !important;
          padding: 8px !important;
          font-weight: 500 !important;
        }
      `}</style>
    </div>
  );
};

export default DispatcherGeoMap;