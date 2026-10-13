// src/services/unitService.ts
import {
  firestore,
  collection,
  doc,
  onSnapshot,
  getDocs,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  where,
  Timestamp,
  type QuerySnapshot,
  type DocumentSnapshot,
} from './firebase';
import type { ResponseUnit, UnitTrackingHistory } from '../types';

export type UnitStatus =
  | 'Available'
  | 'Dispatched'
  | 'EnRoute'
  | 'OnScene'
  | 'OffDuty';

// ⭐ STANDARDIZED collection names (matches Android + DispatcherGeoMap.tsx)
export const UNITS_COLLECTION = 'units';
export const UNIT_HISTORY_COLLECTION = 'unit_tracking_history';
export const UNIT_DISPATCHES_COLLECTION = 'unit_dispatches';

interface UnitUpdates {
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────
// MAPPER — supports BOTH legacy and current field names
// ⭐ Maps `last_active` and `is_online` so the dispatcher's
//    heartbeat / live-availability filter works end-to-end.
// ─────────────────────────────────────────────────────────────
const mapUnit = (data: Record<string, unknown>, id: string): ResponseUnit => {
  const assignedId =
    (data.assigned_incident_id as string) ||
    (data.current_incident_id as string) ||
    null;

  const currentId =
    (data.current_incident_id as string) ||
    (data.assigned_incident_id as string) ||
    null;

  // ⭐ Android LocationService writes `last_active` (epoch millis) on every
  //    GPS ping (~every 2 s). The dispatcher uses this to hide stale units.
  const lastActive =
    typeof data.last_active === 'number'
      ? data.last_active
      : typeof data.last_active === 'string' && data.last_active !== ''
        ? Number(data.last_active)
        : undefined;

  // ⭐ `is_online` is set to true on service start and false on service stop.
  const isOnline =
    typeof data.is_online === 'boolean' ? data.is_online : undefined;

  return {
    unit_id: (data.unit_id as string) || id,
    unit_name: (data.unit_name as string) || 'Unknown Unit',
    unit_code: (data.unit_code as string) || id,
    status: (data.status as ResponseUnit['status']) || 'Available',
    latitude: typeof data.latitude === 'number' ? data.latitude : 18.2604,
    longitude: typeof data.longitude === 'number' ? data.longitude : 121.9968,
    speed: typeof data.speed === 'number' ? data.speed : 0,
    heading: typeof data.heading === 'number' ? data.heading : 0,
    assigned_incident_id: assignedId,
    current_incident_id: currentId,
    eta_seconds: typeof data.eta_seconds === 'number' ? data.eta_seconds : 0,
    last_update: data.last_update
      ? new Date(data.last_update as string).toISOString()
      : new Date().toISOString(),

    // ⭐ NEW — heartbeat fields
    last_active: lastActive,
    is_online: isOnline,

    crew_info: Array.isArray(data.crew_info)
      ? (data.crew_info as ResponseUnit['crew_info'])
      : [],
    fuel_level: typeof data.fuel_level === 'number' ? data.fuel_level : 100,
  } as ResponseUnit;
};

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────
export const createUnit = async (
  unitData: Partial<ResponseUnit>
): Promise<string> => {
  const unitId = `unit-${Date.now()}`;
  const timestamp = new Date().toISOString();

  const newUnit = {
    unit_id: unitId,
    unit_name: unitData.unit_name || 'New Unit',
    unit_code: unitData.unit_code || `FT-${Math.floor(Math.random() * 1000)}`,
    status: 'Available',
    latitude: unitData.latitude || 18.2604,
    longitude: unitData.longitude || 121.9968,
    speed: 0,
    heading: 0,
    assigned_incident_id: null,
    current_incident_id: null,
    eta_seconds: 0,
    last_update: timestamp,
    last_active: Date.now(), // ⭐ seed heartbeat
    is_online: false,
    crew_info: unitData.crew_info || [],
    fuel_level: unitData.fuel_level || 100,
    created_at: timestamp,
  };

  await setDoc(doc(collection(firestore, UNITS_COLLECTION), unitId), newUnit);
  return unitId;
};

// ─────────────────────────────────────────────────────────────
// SUBSCRIBE — ALL UNITS (real-time)
// ─────────────────────────────────────────────────────────────
export const subscribeToUnits = (
  callback: (units: ResponseUnit[]) => void,
  filterByStatus?: string[]
): (() => void) => {
  const unitsRef = collection(firestore, UNITS_COLLECTION);

  return onSnapshot(
    unitsRef,
    (snapshot: QuerySnapshot) => {
      let units: ResponseUnit[] = snapshot.docs.map((docSnapshot: DocumentSnapshot) =>
        mapUnit(docSnapshot.data() as Record<string, unknown>, docSnapshot.id)
      );

      if (filterByStatus && filterByStatus.length > 0) {
        units = units.filter((unit: ResponseUnit) =>
          filterByStatus.includes(unit.status)
        );
      }

      callback(units);
    },
    (error: Error) => {
      console.error('Error loading units:', error);
      callback([]);
    }
  );
};

// ─────────────────────────────────────────────────────────────
// SUBSCRIBE — SINGLE UNIT
// ─────────────────────────────────────────────────────────────
export const subscribeToUnit = (
  unitId: string,
  callback: (unit: ResponseUnit | null) => void
): (() => void) => {
  const unitRef = doc(collection(firestore, UNITS_COLLECTION), unitId);

  return onSnapshot(
    unitRef,
    (snapshot: DocumentSnapshot) => {
      const data = snapshot.exists()
        ? (snapshot.data() as Record<string, unknown>)
        : null;
      callback(data ? mapUnit(data, unitId) : null);
    },
    (error: Error) => {
      console.error('Error loading unit:', error);
      callback(null);
    }
  );
};

// ─────────────────────────────────────────────────────────────
// ⭐ UPDATE UNIT STATUS — dual-schema writes
// ─────────────────────────────────────────────────────────────
export const updateUnitStatus = async (
  unitId: string,
  status: string,
  currentIncidentId?: string | null
): Promise<void> => {
  const timestamp = new Date().toISOString();
  const unitRef = doc(collection(firestore, UNITS_COLLECTION), unitId);

  const updates: UnitUpdates = {
    status,
    last_update: timestamp,
    updated_at: serverTimestamp(),
  };

  if (currentIncidentId !== undefined) {
    // Write BOTH field names so any reader stays in sync
    updates.assigned_incident_id = currentIncidentId;
    updates.current_incident_id = currentIncidentId;
  }

  // Best-effort history entry (never block the status write)
  try {
    const snapshot = await getDoc(unitRef);
    if (snapshot.exists()) {
      const unitData = snapshot.data() as Record<string, unknown>;
      await addHistoryEntry({
        unit_id: unitId,
        latitude: typeof unitData.latitude === 'number' ? unitData.latitude : 0,
        longitude:
          typeof unitData.longitude === 'number' ? unitData.longitude : 0,
        status,
      });
    }
  } catch (historyErr) {
    console.warn('addHistoryEntry failed (non-fatal):', historyErr);
  }

  await updateDoc(unitRef, updates);
};

// ─────────────────────────────────────────────────────────────
// UPDATE UNIT LOCATION
// ─────────────────────────────────────────────────────────────
export const updateUnitLocation = async (
  unitId: string,
  latitude: number,
  longitude: number,
  speed: number,
  heading: number
): Promise<void> => {
  const timestamp = new Date().toISOString();

  await updateDoc(doc(collection(firestore, UNITS_COLLECTION), unitId), {
    latitude,
    longitude,
    speed,
    heading,
    last_update: timestamp,
    last_active: Date.now(), // ⭐ refresh heartbeat
    updated_at: serverTimestamp(),
  });

  try {
    await addHistoryEntry({
      unit_id: unitId,
      latitude,
      longitude,
      status: 'EnRoute',
    });
  } catch (historyErr) {
    console.warn('addHistoryEntry (location) failed (non-fatal):', historyErr);
  }
};

// ─────────────────────────────────────────────────────────────
// UPDATE UNIT DETAILS
// ─────────────────────────────────────────────────────────────
export const updateUnitDetails = async (
  unitId: string,
  updates: Partial<ResponseUnit>
): Promise<void> => {
  const unitUpdates: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    if (key !== 'unit_id') {
      unitUpdates[key] = value;
    }
  });

  unitUpdates.last_update = new Date().toISOString();
  unitUpdates.updated_at = serverTimestamp();

  await updateDoc(
    doc(collection(firestore, UNITS_COLLECTION), unitId),
    unitUpdates
  );
};

// ─────────────────────────────────────────────────────────────
// DELETE UNIT
// ─────────────────────────────────────────────────────────────
export const deleteUnit = async (unitId: string): Promise<void> => {
  await deleteDoc(doc(collection(firestore, UNITS_COLLECTION), unitId));
};

// ─────────────────────────────────────────────────────────────
// CALCULATE ETA (haversine, km ÷ speed)
// ─────────────────────────────────────────────────────────────
export const calculateETA = (
  unit: ResponseUnit,
  destinationLat: number,
  destinationLng: number
): number => {
  const R = 6371;
  const dLat = ((destinationLat - unit.latitude) * Math.PI) / 180;
  const dLon = ((destinationLng - unit.longitude) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((unit.latitude * Math.PI) / 180) *
      Math.cos((destinationLat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  const speed = unit.speed > 5 ? unit.speed : 40;
  return Math.round((distance / speed) * 3600);
};

// ─────────────────────────────────────────────────────────────
// GET ALL UNITS (one-shot)
// ─────────────────────────────────────────────────────────────
export const getAllUnits = async (): Promise<ResponseUnit[]> => {
  const unitsRef = collection(firestore, UNITS_COLLECTION);
  const snapshot = await getDocs(unitsRef);
  return snapshot.docs.map((docSnapshot: DocumentSnapshot) =>
    mapUnit(docSnapshot.data() as Record<string, unknown>, docSnapshot.id)
  );
};

// ─────────────────────────────────────────────────────────────
// HISTORY HELPER (internal)
// ─────────────────────────────────────────────────────────────
const addHistoryEntry = async (
  entry: Omit<UnitTrackingHistory, 'track_id' | 'recorded_at'>
): Promise<void> => {
  await addDoc(collection(firestore, UNIT_HISTORY_COLLECTION), {
    ...entry,
    recorded_at: new Date().toISOString(),
    created_at: serverTimestamp(),
  });
};

// ─────────────────────────────────────────────────────────────
// SIMPLE STATUS UPDATER (kept for compatibility)
// ─────────────────────────────────────────────────────────────
export async function updateUnitStatusSimple(
  unitId: string,
  status: string,
  incidentId?: string | null
): Promise<void> {
  const ref = doc(firestore, UNITS_COLLECTION, unitId);
  await updateDoc(ref, {
    status,
    current_incident_id: incidentId ?? null,
    assigned_incident_id: incidentId ?? null,
    updated_at: serverTimestamp(),
  });
}

// ─────────────────────────────────────────────────────────────
// ⭐ DISPATCH UNIT — writes order + flips unit to Dispatched
//    Also stores route snapshot so the mobile alert shows ETA
// ─────────────────────────────────────────────────────────────
export const dispatchUnit = async (params: {
  unitId: string;
  unitName: string;
  unitCode: string;
  incidentId: string;
  latitude: number;
  longitude: number;
  locationAddress?: string;
  threatLevel?: string;
  description?: string;
  callerName?: string;
  callerPhone?: string;
  dispatcherId: string;
  dispatcherName: string;
  routeDistanceKm?: number;
  routeDistanceText?: string;
  routeEtaMinutes?: number;
  routeEtaText?: string;
  routeFromLat?: number;
  routeFromLng?: number;
}): Promise<string> => {
  const now = Timestamp.now();

  const dispatchRef = await addDoc(
    collection(firestore, UNIT_DISPATCHES_COLLECTION),
    {
      target_unit_id: params.unitId,
      target_unit_name: params.unitName,
      target_unit_code: params.unitCode,
      incident_id: params.incidentId,
      latitude: params.latitude,
      longitude: params.longitude,
      location_address: params.locationAddress || '',
      threat_level: params.threatLevel || 'RED',
      description: params.description || '',
      caller_name: params.callerName || '',
      caller_phone: params.callerPhone || '',

      // ⭐ Route snapshot for the mobile alert
      route_distance_km: params.routeDistanceKm ?? null,
      route_distance_text: params.routeDistanceText ?? '',
      route_eta_minutes: params.routeEtaMinutes ?? null,
      route_eta_text: params.routeEtaText ?? '',
      route_from_lat: params.routeFromLat ?? null,
      route_from_lng: params.routeFromLng ?? null,

      dispatcher_id: params.dispatcherId,
      dispatcher_name: params.dispatcherName,

      dispatched_at: now,
      acknowledged: false,
      acknowledged_at: null,
      acknowledged_by_unit: null,
      acknowledged_by_unit_name: null,
      navigation_started: false,
      navigation_started_at: null,
      status: 'pending',

      created_at: serverTimestamp(),
      updated_at: now,
    }
  );

  await updateUnitStatus(params.unitId, 'Dispatched', params.incidentId);
  return dispatchRef.id;
};

// ─────────────────────────────────────────────────────────────
// ⭐ CANCEL OPEN DISPATCHES — used by watchdog + Force Available
// ─────────────────────────────────────────────────────────────
export const cancelOpenDispatchesForUnit = async (
  unitId: string,
  cancelledBy: string = 'dispatcher'
): Promise<number> => {
  const q = query(
    collection(firestore, UNIT_DISPATCHES_COLLECTION),
    where('target_unit_id', '==', unitId),
    where('acknowledged', '==', false)
  );

  const snap = await getDocs(q);
  let count = 0;

  for (const docSnap of snap.docs) {
    await updateDoc(
      doc(firestore, UNIT_DISPATCHES_COLLECTION, docSnap.id),
      {
        status: 'cancelled',
        cancelled: true,
        cancelled_at: serverTimestamp(),
        cancelled_by: cancelledBy,
      }
    ).catch(() => {});
    count++;
  }

  return count;
};

// ─────────────────────────────────────────────────────────────
// ⭐ FORCE UNIT AVAILABLE — manual reset
// ─────────────────────────────────────────────────────────────
export const forceUnitAvailable = async (
  unitId: string,
  cancelledBy: string = 'dispatcher_manual'
): Promise<{ cancelledDispatches: number }> => {
  const cancelledDispatches = await cancelOpenDispatchesForUnit(
    unitId,
    cancelledBy
  );
  await updateUnitStatus(unitId, 'Available', null);
  return { cancelledDispatches };
};

// ─────────────────────────────────────────────────────────────
// ⭐ SEED DEFAULT UNITS — ensures Unit 1 & Unit 2 exist
// ─────────────────────────────────────────────────────────────
export const seedDefaultUnitsIfEmpty = async (
  fireStationLocation: { lat: number; lng: number }
): Promise<{ seeded: boolean; count: number }> => {
  const unitsRef = collection(firestore, UNITS_COLLECTION);
  const existing = await getDocs(unitsRef);

  if (!existing.empty) {
    return { seeded: false, count: existing.size };
  }

  const defaults = [
    { unit_id: 'UNIT-001', unit_code: 'U1', unit_name: 'Unit 1' },
    { unit_id: 'UNIT-002', unit_code: 'U2', unit_name: 'Unit 2' },
  ];

  const now = Date.now();

  for (const unit of defaults) {
    await setDoc(doc(firestore, UNITS_COLLECTION, unit.unit_id), {
      unit_id: unit.unit_id,
      unit_code: unit.unit_code,
      unit_name: unit.unit_name,
      status: 'Available',
      latitude: fireStationLocation.lat,
      longitude: fireStationLocation.lng,
      speed: 0,
      heading: 0,
      assigned_incident_id: null,
      current_incident_id: null,
      eta_seconds: 0,
      fuel_level: 100,
      crew_info: [],
      is_online: false,
      last_active: 0,
      last_update: new Date().toISOString(),
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
  }

  return { seeded: true, count: defaults.length };
};

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
export type { UnitUpdates };