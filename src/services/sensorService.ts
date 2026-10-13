// src/services/sensorService.ts
// ============================================================
//  Sensor service — v27.0  (stable, deduplicated, real-time)
//
//  Key guarantees:
//   ✅ Same collection the ESP32 uses (iot_sensors)
//   ✅ Shallow-compare dedup — no re-renders on identical data
//   ✅ Unlink on resolution (unlinkSensorIncident)
//   ✅ Commands (silence / clear / buzzer) flow to device
//   ✅ resetSensorState — clears verified/incident/orphan fields
//   ✅ Safe against React StrictMode double-mount
//   ✅ ⭐ admin_* fields (name, phone, email, address, role,
//        emergency) now mapped through to the UI
//   ✅ ⭐ Dedup also compares admin_* so admin edits propagate
// ============================================================

import {
  firestore,
  collection,
  doc,
  onSnapshot,
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
} from './firebase';
import type { IoTSensor, SensorReading } from '../types';
import type { QuerySnapshot, DocumentSnapshot } from 'firebase/firestore';

// ============================================================
//  Collection names — single source of truth
// ============================================================
export const SENSORS_COLLECTION = 'iot_sensors';
export const READINGS_COLLECTION = 'sensor_readings';
export const ALARMS_COLLECTION = 'iot_alarms';

// ============================================================
//  Coercion helpers
// ============================================================
const coerceNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const coerceBoolean = (v: unknown): boolean => v === true || v === 'true';

const coerceString = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v.trim() !== '') return v;
  return undefined;
};

const isValidLatLng = (
  lat: number | undefined,
  lng: number | undefined,
): boolean => {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
};

// ============================================================
//  mapSensorDoc — Firestore doc → IoTSensor
// ============================================================
export const mapSensorDoc = (
  data: Record<string, unknown>,
  id: string,
): IoTSensor => {
  const rawLat = coerceNumber(data.latitude) ?? coerceNumber(data.lat);
  const rawLng = coerceNumber(data.longitude) ?? coerceNumber(data.lng);
  const hasValidCoords = isValidLatLng(rawLat, rawLng);

  const rawHeartbeat = coerceString(data.last_heartbeat);
  const rawInstalled = coerceString(data.installed_at);

  const threat = data.threat_level;
  const normalizedThreat: 'RED' | 'YELLOW' | 'NORMAL' | null =
    threat === 'RED' || threat === 'YELLOW' || threat === 'NORMAL'
      ? threat
      : null;

  const sensor: IoTSensor = {
    sensor_id: coerceString(data.sensor_id) || id,
    location:
      coerceString(data.location) ||
      coerceString(data.location_name) ||
      'Unknown location',
    latitude: hasValidCoords ? (rawLat as number) : 0,
    longitude: hasValidCoords ? (rawLng as number) : 0,
    sensor_type:
      (coerceString(data.sensor_type) as IoTSensor['sensor_type']) ||
      'fire_gas_sensor',
    status: (coerceString(data.status) as IoTSensor['status']) || 'Offline',
    battery_level: coerceNumber(data.battery_level) ?? 0,
    last_heartbeat: rawHeartbeat || '',
    installed_at: rawInstalled || '',

    threat_level: normalizedThreat,
    location_name: coerceString(data.location_name),
    building: coerceString(data.building),
    room: coerceString(data.room),
    floor: coerceString(data.floor),
    temperature: coerceNumber(data.temperature),
    humidity: coerceNumber(data.humidity),
    gas: coerceNumber(data.gas),
    gas_baseline: coerceNumber(data.gas_baseline),
    gasDOUT: coerceBoolean(data.gasDOUT),
    flame: coerceBoolean(data.flame),
    smoke: coerceBoolean(data.smoke),
    buzzer: coerceBoolean(data.buzzer),
    last_seen: coerceString(data.last_seen),
    last_update: coerceString(data.last_update),
    uptime: coerceNumber(data.uptime),
    timeSynced: coerceBoolean(data.timeSynced),
    accuracy: coerceNumber(data.accuracy),
    provider: coerceString(data.provider),

    dispatcher_acknowledged: coerceBoolean(data.dispatcher_acknowledged),
    dispatcher_acknowledged_at: coerceString(data.dispatcher_acknowledged_at),
    dispatcher_acknowledged_by: coerceString(data.dispatcher_acknowledged_by),
    dispatcher_acknowledged_by_name: coerceString(
      data.dispatcher_acknowledged_by_name,
    ),
    verified: coerceBoolean(data.verified),
    verified_at: coerceString(data.verified_at),
    verified_by: coerceString(data.verified_by),
    verified_by_name: coerceString(data.verified_by_name),
    incident_id: coerceString(data.incident_id),

    commandSilence: coerceBoolean(data.commandSilence),
    commandSilenceAt: coerceString(data.commandSilenceAt),
    commandClear: coerceBoolean(data.commandClear),
    commandClearAt: coerceString(data.commandClearAt),
    commandBuzzer: coerceBoolean(data.commandBuzzer),
    commandBuzzerAt: coerceString(data.commandBuzzerAt),
    commandSilenceBy: coerceString(data.commandSilenceBy),
    commandClearBy: coerceString(data.commandClearBy),
    commandBuzzerBy: coerceString(data.commandBuzzerBy),
    commandSilenceByName: coerceString(data.commandSilenceByName),
    commandClearByName: coerceString(data.commandClearByName),
    commandBuzzerByName: coerceString(data.commandBuzzerByName),

    // ⭐ ADMIN-OWNED METADATA — without these the Owner Info
    //    section in the Sensor Details modal shows "Not set".
    admin_name: coerceString(data.admin_name) || '',
    admin_phone: coerceString(data.admin_phone) || '',
    admin_email: coerceString(data.admin_email) || '',
    admin_address: coerceString(data.admin_address) || '',
    admin_role: coerceString(data.admin_role) || '',
    admin_emergency: coerceString(data.admin_emergency) || '',

    // ⭐ Aliases used by the Add Sensor form
    name: coerceString(data.name),
    phone: coerceString(data.phone),

    // ⭐ Extra admin fields
    created_at: coerceString(data.created_at),
    updated_at: coerceString(data.updated_at),
  } as IoTSensor;

  return sensor;
};

// ============================================================
//  mapReading
// ============================================================
const mapReading = (
  data: Record<string, unknown>,
  id: string,
): SensorReading => {
  return {
    reading_id: id,
    sensor_id: coerceString(data.sensor_id) || '',
    smoke_ppm: coerceNumber(data.smoke_ppm) ?? null,
    temperature: coerceNumber(data.temperature) ?? null,
    flame_detected: coerceBoolean(data.flame_detected),
    flame_confidence: coerceNumber(data.flame_confidence) ?? null,
    is_alert: coerceBoolean(data.is_alert),
    read_at: coerceString(data.read_at) || '',
    received_at: coerceString(data.received_at) || '',
  };
};

// ============================================================
//  SHALLOW-EQUALITY CHECK — prevents re-render cascades
//  Now also compares admin_* fields so admin edits propagate.
// ============================================================
const sensorsAreEqual = (a: IoTSensor[], b: IoTSensor[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] as any;
    const sb = b[i] as any;
    if (sa.sensor_id !== sb.sensor_id) return false;
    if (sa.threat_level !== sb.threat_level) return false;
    if (sa.status !== sb.status) return false;
    if (sa.flame !== sb.flame) return false;
    if (sa.gasDOUT !== sb.gasDOUT) return false;
    if (sa.temperature !== sb.temperature) return false;
    if (sa.humidity !== sb.humidity) return false;
    if (sa.gas !== sb.gas) return false;
    if (sa.dispatcher_acknowledged !== sb.dispatcher_acknowledged) return false;
    if (sa.verified !== sb.verified) return false;
    if (sa.incident_id !== sb.incident_id) return false;
    if (sa.latitude !== sb.latitude) return false;
    if (sa.longitude !== sb.longitude) return false;
    if (sa.commandSilence !== sb.commandSilence) return false;
    if (sa.commandClear !== sb.commandClear) return false;
    if (sa.commandBuzzer !== sb.commandBuzzer) return false;

    // ⭐ Admin-owned metadata — must be compared or admin edits
    //    get silently dropped by the dedup logic.
    if (sa.admin_name !== sb.admin_name) return false;
    if (sa.admin_phone !== sb.admin_phone) return false;
    if (sa.admin_email !== sb.admin_email) return false;
    if (sa.admin_address !== sb.admin_address) return false;
    if (sa.admin_role !== sb.admin_role) return false;
    if (sa.admin_emergency !== sb.admin_emergency) return false;

    // ⭐ Location text fields also affect the UI
    if (sa.location !== sb.location) return false;
    if (sa.location_name !== sb.location_name) return false;
    if (sa.building !== sb.building) return false;
    if (sa.room !== sb.room) return false;
    if (sa.floor !== sb.floor) return false;
    if (sa.installed_at !== sb.installed_at) return false;
    if (sa.last_heartbeat !== sb.last_heartbeat) return false;
  }
  return true;
};

// ============================================================
//  Subscribe to ALL sensors (real-time, deduplicated)
// ============================================================
export const subscribeToSensors = (
  callback: (sensors: IoTSensor[]) => void,
  onError?: (err: Error) => void,
): (() => void) => {
  const sensorsRef = collection(firestore, SENSORS_COLLECTION);

  console.log(
    '📡 [sensorService] subscribeToSensors: STARTING subscription to',
    SENSORS_COLLECTION,
  );

  let lastSensors: IoTSensor[] = [];

  return onSnapshot(
    sensorsRef,
    (snapshot: QuerySnapshot) => {
      const sensors: IoTSensor[] = snapshot.docs.map(
        (docSnapshot: DocumentSnapshot) =>
          mapSensorDoc(
            docSnapshot.data() as Record<string, unknown>,
            docSnapshot.id,
          ),
      );

      if (sensorsAreEqual(sensors, lastSensors)) {
        return;
      }
      lastSensors = sensors;
      callback(sensors);
    },
    (error: Error) => {
      console.error('❌ [sensorService] subscribeToSensors ERROR:', error);
      console.error('   Code:', (error as any).code);
      console.error('   Message:', error.message);
      if (onError) onError(error);
      callback([]);
    },
  );
};

// ============================================================
//  Subscribe to ACTIVE sensors (includes NORMAL)
// ============================================================
export const subscribeToActiveSensors = (
  callback: (sensors: IoTSensor[]) => void,
  onError?: (err: Error) => void,
): (() => void) => {
  const sensorsRef = collection(firestore, SENSORS_COLLECTION);
  let lastSensors: IoTSensor[] = [];

  return onSnapshot(
    sensorsRef,
    (snapshot: QuerySnapshot) => {
      const sensors: IoTSensor[] = snapshot.docs
        .map((docSnapshot: DocumentSnapshot) =>
          mapSensorDoc(
            docSnapshot.data() as Record<string, unknown>,
            docSnapshot.id,
          ),
        )
        .filter((s) => s.status === 'Active');

      if (sensorsAreEqual(sensors, lastSensors)) return;
      lastSensors = sensors;
      callback(sensors);
    },
    (error: Error) => {
      console.error('[sensorService] subscribeToActiveSensors error:', error);
      if (onError) onError(error);
      callback([]);
    },
  );
};

// ============================================================
//  Subscribe to sensors in threat state (RED or YELLOW)
// ============================================================
export const subscribeToThreatSensors = (
  callback: (sensors: IoTSensor[]) => void,
  onError?: (err: Error) => void,
): (() => void) => {
  const sensorsRef = collection(firestore, SENSORS_COLLECTION);
  let lastSensors: IoTSensor[] = [];

  return onSnapshot(
    sensorsRef,
    (snapshot: QuerySnapshot) => {
      const sensors: IoTSensor[] = snapshot.docs
        .map((docSnapshot: DocumentSnapshot) =>
          mapSensorDoc(
            docSnapshot.data() as Record<string, unknown>,
            docSnapshot.id,
          ),
        )
        .filter(
          (s) =>
            s.status === 'Active' &&
            (s.threat_level === 'RED' || s.threat_level === 'YELLOW'),
        );

      if (sensorsAreEqual(sensors, lastSensors)) return;
      lastSensors = sensors;
      callback(sensors);
    },
    (error: Error) => {
      console.error('[sensorService] subscribeToThreatSensors error:', error);
      if (onError) onError(error);
      callback([]);
    },
  );
};

// ============================================================
//  Subscribe to ONE sensor
// ============================================================
export const subscribeToSensor = (
  sensorId: string,
  callback: (sensor: IoTSensor | null) => void,
): (() => void) => {
  const sensorRef = doc(collection(firestore, SENSORS_COLLECTION), sensorId);

  return onSnapshot(
    sensorRef,
    (snapshot: DocumentSnapshot) => {
      const data = snapshot.exists()
        ? (snapshot.data() as Record<string, unknown>)
        : null;
      callback(data ? mapSensorDoc(data, sensorId) : null);
    },
    (error: Error) => {
      console.error('[sensorService] subscribeToSensor error:', error);
      callback(null);
    },
  );
};

// ============================================================
//  Create sensor
// ============================================================
export const createSensor = async (
  sensorData: Partial<IoTSensor> & { sensor_id?: string },
): Promise<string> => {
  const sensorId = sensorData.sensor_id || `SENSOR_${Date.now()}`;
  const timestamp = new Date().toISOString();

  const newSensor: Record<string, unknown> = {
    sensor_id: sensorId,
    location: sensorData.location || 'New Location',
    location_name:
      sensorData.location_name || sensorData.location || 'New Location',
    latitude:
      typeof sensorData.latitude === 'number' ? sensorData.latitude : 18.2604,
    longitude:
      typeof sensorData.longitude === 'number' ? sensorData.longitude : 121.9968,
    sensor_type: sensorData.sensor_type || 'fire_gas_sensor',
    status: sensorData.status || 'Active',
    battery_level:
      typeof sensorData.battery_level === 'number'
        ? sensorData.battery_level
        : 100,
    threat_level: 'NORMAL',
    last_heartbeat: timestamp,
    installed_at: timestamp,
    created_at: serverTimestamp(),
    updated_at: timestamp,
  };

  await setDoc(
    doc(collection(firestore, SENSORS_COLLECTION), sensorId),
    newSensor,
  );
  return sensorId;
};

// ============================================================
//  Update sensor
// ============================================================
export const updateSensor = async (
  sensorId: string,
  updates: Partial<IoTSensor>,
): Promise<void> => {
  const sensorUpdates: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (key === 'sensor_id') return;
    if (value === undefined) return;
    sensorUpdates[key] = value;
  });

  if (!('last_heartbeat' in sensorUpdates)) {
    sensorUpdates.last_heartbeat = new Date().toISOString();
  }
  sensorUpdates.updated_at = new Date().toISOString();

  await updateDoc(
    doc(collection(firestore, SENSORS_COLLECTION), sensorId),
    sensorUpdates,
  );
};

// ============================================================
//  Delete sensor
// ============================================================
export const deleteSensor = async (sensorId: string): Promise<void> => {
  await deleteDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId));
};

// ============================================================
//  Get all sensors (one-shot)
// ============================================================
export const getAllSensors = async (): Promise<IoTSensor[]> => {
  const sensorsRef = collection(firestore, SENSORS_COLLECTION);
  const snapshot = await getDocs(sensorsRef);
  return snapshot.docs.map((docSnapshot: DocumentSnapshot) =>
    mapSensorDoc(
      docSnapshot.data() as Record<string, unknown>,
      docSnapshot.id,
    ),
  );
};

// ============================================================
//  Get one sensor (one-shot)
// ============================================================
export const getSensor = async (
  sensorId: string,
): Promise<IoTSensor | null> => {
  const snap = await getDoc(
    doc(collection(firestore, SENSORS_COLLECTION), sensorId),
  );
  if (!snap.exists()) return null;
  return mapSensorDoc(snap.data() as Record<string, unknown>, snap.id);
};

// ============================================================
//  DISPATCHER → SENSOR WRITE-BACK
// ============================================================

/** Acknowledge a sensor (does not verify it). */
export const acknowledgeSensorDoc = async (
  sensorId: string,
  dispatcherId: string,
  dispatcherName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    dispatcher_acknowledged: true,
    dispatcher_acknowledged_at: now,
    dispatcher_acknowledged_by: dispatcherId,
    dispatcher_acknowledged_by_name: dispatcherName,
    updated_at: now,
  });
};

/** Verify a sensor + link it to an incident. */
export const verifySensorDoc = async (
  sensorId: string,
  incidentId: string,
  dispatcherId: string,
  dispatcherName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    dispatcher_acknowledged: true,
    dispatcher_acknowledged_at: now,
    dispatcher_acknowledged_by: dispatcherId,
    dispatcher_acknowledged_by_name: dispatcherName,
    verified: true,
    verified_at: now,
    verified_by: dispatcherId,
    verified_by_name: dispatcherName,
    incident_id: incidentId,
    updated_at: now,
  });
};

/** Break the sensor ↔ incident link (used when incident resolves). */
export const unlinkSensorIncident = async (
  sensorId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    verified: false,
    verified_at: null,
    verified_by: null,
    verified_by_name: null,
    incident_id: null,
    dispatcher_acknowledged: false,
    dispatcher_acknowledged_at: null,
    dispatcher_acknowledged_by: null,
    dispatcher_acknowledged_by_name: null,
    updated_at: now,
  });
};

/** Reset sensor's dispatcher state entirely. */
export const resetSensorState = async (
  sensorId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    dispatcher_acknowledged: false,
    dispatcher_acknowledged_at: null,
    dispatcher_acknowledged_by: null,
    dispatcher_acknowledged_by_name: null,

    verified: false,
    verified_at: null,
    verified_by: null,
    verified_by_name: null,
    incident_id: null,

    resolved: false,
    resolved_at: null,
    resolved_by: null,
    resolved_by_name: null,
    marker_visible: true,

    updated_at: now,
  });
};

/** Clear a sensor entirely. */
export const clearSensor = async (
  sensorId: string,
  dispatcherId: string,
  dispatcherName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    threat_level: 'NORMAL',
    dispatcher_acknowledged: false,
    dispatcher_acknowledged_at: null,
    dispatcher_acknowledged_by: null,
    dispatcher_acknowledged_by_name: null,
    verified: false,
    verified_at: null,
    verified_by: null,
    verified_by_name: null,
    incident_id: null,
    resolved: false,
    resolved_at: null,
    resolved_by: null,
    resolved_by_name: null,
    marker_visible: true,
    commandClear: true,
    commandClearAt: now,
    commandClearBy: dispatcherId,
    commandClearByName: dispatcherName,
    updated_at: now,
  });
};

/** Remote buzzer test — ESP32 buzzes for a few seconds. */
export const commandSensorBuzzer = async (
  sensorId: string,
  dispatcherId: string,
  dispatcherName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    commandBuzzer: true,
    commandBuzzerAt: now,
    commandBuzzerBy: dispatcherId,
    commandBuzzerByName: dispatcherName,
    updated_at: now,
  });
};

/** Force-silence the ESP32's buzzer. */
export const commandSensorSilence = async (
  sensorId: string,
  dispatcherId: string,
  dispatcherName: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    commandSilence: true,
    commandSilenceAt: now,
    commandSilenceBy: dispatcherId,
    commandSilenceByName: dispatcherName,
    updated_at: now,
  });
};

// ============================================================
//  Readings
// ============================================================
export const addSensorReading = async (
  sensorId: string,
  reading: Partial<SensorReading>,
): Promise<void> => {
  const timestamp = new Date().toISOString();

  const newReading: SensorReading = {
    reading_id: '',
    sensor_id: sensorId,
    smoke_ppm: reading.smoke_ppm ?? null,
    temperature: reading.temperature ?? null,
    flame_detected: reading.flame_detected ?? false,
    flame_confidence: reading.flame_confidence ?? null,
    is_alert: reading.is_alert ?? false,
    read_at: reading.read_at || timestamp,
    received_at: timestamp,
  };

  await addDoc(collection(firestore, READINGS_COLLECTION), {
    ...newReading,
    created_at: serverTimestamp(),
  });

  await updateDoc(doc(collection(firestore, SENSORS_COLLECTION), sensorId), {
    last_heartbeat: timestamp,
    updated_at: timestamp,
  });
};

export const subscribeToSensorReadings = (
  sensorId: string,
  callback: (readings: SensorReading[]) => void,
  maxReadings: number = 100,
): (() => void) => {
  const readingsQuery = query(
    collection(firestore, READINGS_COLLECTION),
    where('sensor_id', '==', sensorId),
    orderBy('read_at', 'desc'),
    limit(maxReadings),
  );

  return onSnapshot(
    readingsQuery,
    (snapshot: QuerySnapshot) => {
      const readings: SensorReading[] = snapshot.docs.map(
        (docSnapshot: DocumentSnapshot) =>
          mapReading(
            docSnapshot.data() as Record<string, unknown>,
            docSnapshot.id,
          ),
      );
      callback(readings);
    },
    (error: Error) => {
      console.error(
        '[sensorService] subscribeToSensorReadings error:',
        error,
      );
      callback([]);
    },
  );
};

export const subscribeToAllSensorReadings = (
  callback: (readings: SensorReading[]) => void,
  maxReadings: number = 200,
): (() => void) => {
  const readingsQuery = query(
    collection(firestore, READINGS_COLLECTION),
    orderBy('read_at', 'desc'),
    limit(maxReadings),
  );

  return onSnapshot(
    readingsQuery,
    (snapshot: QuerySnapshot) => {
      const readings: SensorReading[] = snapshot.docs.map(
        (docSnapshot: DocumentSnapshot) =>
          mapReading(
            docSnapshot.data() as Record<string, unknown>,
            docSnapshot.id,
          ),
      );
      callback(readings);
    },
    (error: Error) => {
      console.error(
        '[sensorService] subscribeToAllSensorReadings error:',
        error,
      );
      callback([]);
    },
  );
};