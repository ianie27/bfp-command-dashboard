// src/services/incidentService.ts
import {
  firestore,
  collection,
  doc,
  onSnapshot,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from './firebase';
import type { Incident, IncidentStatusHistory } from '../types';
import type { QuerySnapshot, DocumentSnapshot } from 'firebase/firestore';

export type IncidentStatus =
  | 'Received'
  | 'Verified'
  | 'Acknowledged'
  | 'Connected'
  | 'Dispatched'
  | 'EnRoute'
  | 'OnScene'
  | 'Resolved'
  | 'Cancelled'
  | 'Ended'
  | 'Dismissed';

interface IncidentUpdates {
  [key: string]: unknown;
}

export const INCIDENTS_COLLECTION = 'incidents';
export const HISTORY_COLLECTION = 'incident_status_history';
export const INCIDENT_UNITS_COLLECTION = 'response_units';
export const DISPATCHES_COLLECTION = 'dispatches';

const DASHBOARD_STATUSES: IncidentStatus[] = [
  'Received', 'Verified', 'Acknowledged', 'Connected',
  'Dispatched', 'EnRoute', 'OnScene', 'Resolved', 'Cancelled',
  'Ended', 'Dismissed',
];

// ============================================================
// Date normalizer
// ============================================================
const fromAppOrDate = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return new Date().toISOString();

  if (typeof (value as any)?.toDate === 'function') {
    try {
      return (value as any).toDate().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as any).seconds === 'number'
  ) {
    return new Date((value as any).seconds * 1000).toISOString();
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }

  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  return new Date().toISOString();
};

const fromAppOrDateOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return fromAppOrDate(value);
};

const mapStatus = (status: unknown): IncidentStatus => {
  if (typeof status !== 'string' || status.trim() === '') return 'Received';
  const s = status.trim();

  if (s === 'initiated') return 'Received';
  if (s === 'ended') return 'Resolved';
  if (s === 'connected') return 'Connected';
  if (s === 'acknowledged') return 'Acknowledged';
  if (s === 'dismissed') return 'Dismissed';

  if (DASHBOARD_STATUSES.includes(s as IncidentStatus)) {
    return s as IncidentStatus;
  }
  return 'Received';
};

// ============================================================
// mapIncident — includes hidden_from_dispatcher flags
// ============================================================
const mapIncident = (data: Record<string, unknown>, id: string): Incident => {
  const reportedAt = fromAppOrDate(
    data.reported_at ??
    data.reportedAt ??
    data.timestamp ??
    data.created_at ??
    data.createdAt
  );

  const createdAt = fromAppOrDate(
    data.created_at ??
    data.createdAt ??
    data.timestamp ??
    data.reported_at
  );

  const updatedAt = fromAppOrDate(
    data.updated_at ??
    data.updatedAt ??
    data.created_at ??
    data.timestamp
  );

  const endedAt = fromAppOrDateOrNull(
    data.endTimestamp ?? data.ended_at ?? data.resolved_at
  );

  const incidentId =
    (data.incident_id as string) ||
    (data.reportId as string) ||
    id;

  const locationAddress =
    (data.location_address as string) ||
    (data.address as string) ||
    (data.location as string) ||
    null;

  const rawSource = data.source;
  const source: Incident['source'] =
    rawSource === 'iot_sensor' ? 'iot_sensor' : 'citizen';

  return {
    id,
    incident_id: incidentId,

    citizen_reporter:
      (data.citizen_reporter as string) ||
      (data.userId as string) ||
      (data.caller_name as string) ||
      null,

    guest_reporter:
      !data.userId && !data.citizen_reporter && !data.emergency_id,

    source,

    iot_sensor_id: (data.iot_sensor_id as string) || null,

    latitude: typeof data.latitude === 'number' ? data.latitude : 0,
    longitude: typeof data.longitude === 'number' ? data.longitude : 0,

    location_address: locationAddress,

    reported_at: reportedAt,
    created_at: createdAt,
    updated_at: updatedAt,

    threat_level: data.threat_level === 'RED' ? 'RED' : 'YELLOW',

    status: mapStatus(data.status),

    description:
      (data.description as string) ||
      (data.type as string) ||
      null,

    fire_intensity:
      (data.fire_intensity as Incident['fire_intensity']) || null,

    verified_by: (data.verified_by as string) || null,
    verified_at: fromAppOrDateOrNull(data.verified_at),
    verified_by_name: (data.verified_by_name as string) || null,

    dispatched_at: fromAppOrDateOrNull(data.dispatched_at),
    en_route_at: fromAppOrDateOrNull(data.en_route_at),
    on_scene_at: fromAppOrDateOrNull(data.on_scene_at),
    resolved_at: fromAppOrDateOrNull(data.resolved_at) ?? endedAt,

    resolved_notes:
      (data.resolved_notes as string) ||
      (data.duration != null ? `Call duration: ${data.duration}s` : null),

    cancelled_reason: (data.cancelled_reason as string) || null,

    is_duplicate: data.is_duplicate === true,
    duplicate_of: (data.duplicate_of as string) || null,

    response_time_seconds:
      typeof data.response_time_seconds === 'number'
        ? data.response_time_seconds
        : null,

    emergency_id: (data.emergency_id as string) || null,
    emergency_call_id: (data.emergency_call_id as string) || null,
    caller_name: (data.caller_name as string) || null,
    caller_phone: (data.caller_phone as string) || null,

    // ⭐ NEW — hidden_from_dispatcher flags
    hidden_from_dispatcher: data.hidden_from_dispatcher === true,
    hidden_at: fromAppOrDateOrNull(data.hidden_at),
    hidden_by: (data.hidden_by as string) || null,
    hidden_by_name: (data.hidden_by_name as string) || null,
    hidden_reason: (data.hidden_reason as string) || null,
  } as Incident;
};

// ============================================================
// createIncident
// ============================================================
export const createIncident = async (
  incidentData: Partial<Incident>
): Promise<string> => {
  const now = new Date().toISOString();

  const incidentId =
    incidentData.incident_id ||
    `INC-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

  const payload: Record<string, unknown> = {
    incident_id: incidentId,

    userId: incidentData.citizen_reporter || null,
    citizen_reporter: incidentData.citizen_reporter || null,

    latitude: incidentData.latitude || 18.2604,
    longitude: incidentData.longitude || 121.9968,

    location: incidentData.location_address || 'Unknown location',
    address: incidentData.location_address || null,
    location_address: incidentData.location_address || null,

    description: incidentData.description || null,
    threat_level: incidentData.threat_level || 'YELLOW',
    fire_intensity: incidentData.fire_intensity || null,

    reportType: 'fire_emergency',
    hotline: '911',
    source: incidentData.source || 'dispatch',
    status: incidentData.status || 'Received',

    timestamp: Date.now(),
    reported_at: now,
    created_at: now,
    updated_at: now,

    duration: 0,

    // ⭐ NEW — default to visible on dispatcher map
    hidden_from_dispatcher: false,
  };

  await setDoc(doc(collection(firestore, INCIDENTS_COLLECTION), incidentId), payload);
  return incidentId;
};

type IncidentCallback = (incidents: Incident[]) => void;

// ============================================================
// subscribeToIncidents — returns EVERYTHING (hidden included)
// The dispatcher filters hidden ones on its side.
// The admin page does NOT filter, so it still sees everything.
// ============================================================
export const subscribeToIncidents = (
  callback: IncidentCallback,
  filterByStatus?: IncidentStatus[]
): (() => void) => {
  console.log('🔥 [incidentService] Subscribing to collection:', INCIDENTS_COLLECTION);

  const incidentsRef = collection(firestore, INCIDENTS_COLLECTION);

  return onSnapshot(
    incidentsRef,
    (snapshot: QuerySnapshot) => {
      console.log(
        `🔥 [incidentService] Snapshot received: ${snapshot.size} docs ` +
        `(${snapshot.docChanges().length} changes)`
      );

      let incidents: Incident[] = snapshot.docs.map((docSnapshot: DocumentSnapshot) =>
        mapIncident(docSnapshot.data() as Record<string, unknown>, docSnapshot.id)
      );

      console.log(
        '🔥 [incidentService] Normalized incident IDs:',
        incidents.map((i) => i.incident_id)
      );

      if (filterByStatus && filterByStatus.length > 0) {
        incidents = incidents.filter((inc: Incident) =>
          filterByStatus.includes(inc.status)
        );
      }

      incidents.sort((a, b) => {
        const ta = new Date(a.reported_at).getTime() || 0;
        const tb = new Date(b.reported_at).getTime() || 0;
        return tb - ta;
      });

      callback(incidents);
    },
    (error: Error) => {
      console.error('❌ [incidentService] Error loading incidents:', error);
      callback([]);
    }
  );
};

// ============================================================
// subscribeToIncident — unchanged
// ============================================================
export const subscribeToIncident = (
  incidentId: string,
  callback: (incident: Incident | null) => void
): (() => void) => {
  const incidentRef = doc(collection(firestore, INCIDENTS_COLLECTION), incidentId);

  return onSnapshot(
    incidentRef,
    (snapshot: DocumentSnapshot) => {
      const data = snapshot.exists()
        ? (snapshot.data() as Record<string, unknown>)
        : null;
      callback(data ? mapIncident(data, incidentId) : null);
    },
    (error: Error) => {
      console.error('Error loading incident:', error);
      callback(null);
    }
  );
};

// ============================================================
// verifyIncident — unchanged
// ============================================================
export const verifyIncident = async (
  incidentId: string,
  verifiedBy: string,
  notes?: string
): Promise<void> => {
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = {
    status: 'Verified',
    verified_by: verifiedBy,
    verified_at: now,
    updated_at: now,
  };

  const q = query(
    collection(firestore, INCIDENTS_COLLECTION),
    where('incident_id', '==', incidentId)
  );
  const snap = await getDocs(q);

  if (!snap.empty) {
    for (const d of snap.docs) {
      await updateDoc(d.ref, updates);
    }
  } else {
    await updateDoc(
      doc(collection(firestore, INCIDENTS_COLLECTION), incidentId),
      updates
    );
  }

  await addDoc(collection(firestore, HISTORY_COLLECTION), {
    incident_id: incidentId,
    status_from: 'Received',
    status_to: 'Verified',
    updated_by: verifiedBy,
    updated_at: now,
    notes: notes || null,
    gps_latitude: null,
    gps_longitude: null,
    created_at: serverTimestamp(),
  });
};

// ============================================================
// dispatchUnits — unchanged
// ============================================================
export const dispatchUnits = async (
  incidentId: string,
  unitIds: string[],
  dispatcherId: string
): Promise<void> => {
  const timestamp = new Date().toISOString();

  const q = query(
    collection(firestore, INCIDENTS_COLLECTION),
    where('incident_id', '==', incidentId)
  );
  const snap = await getDocs(q);

  const updates = {
    status: 'Dispatched',
    dispatched_at: timestamp,
    dispatched_units: unitIds,
    updated_at: timestamp,
  };

  if (!snap.empty) {
    for (const d of snap.docs) {
      await updateDoc(d.ref, updates);
    }
  } else {
    await updateDoc(
      doc(collection(firestore, INCIDENTS_COLLECTION), incidentId),
      updates
    );
  }

  for (const unitId of unitIds) {
    const unitRef = doc(collection(firestore, INCIDENT_UNITS_COLLECTION), unitId);
    await setDoc(
      unitRef,
      {
        unit_id: unitId,
        status: 'Dispatched',
        assigned_incident_id: incidentId,
        last_update: timestamp,
      },
      { merge: true }
    );
  }

  await addDoc(collection(firestore, DISPATCHES_COLLECTION), {
    incident_id: incidentId,
    unit_ids: unitIds,
    dispatched_by: dispatcherId,
    dispatched_at: timestamp,
    created_at: serverTimestamp(),
  });

  await addDoc(collection(firestore, HISTORY_COLLECTION), {
    incident_id: incidentId,
    status_from: 'Verified',
    status_to: 'Dispatched',
    updated_by: dispatcherId,
    updated_at: timestamp,
    notes: `Units dispatched: ${unitIds.join(', ')}`,
    gps_latitude: null,
    gps_longitude: null,
    created_at: serverTimestamp(),
  });
};

// ============================================================
// updateIncidentStatus — unchanged
// ============================================================
export const updateIncidentStatus = async (
  incidentId: string,
  newStatus: IncidentStatus,
  updatedBy: string,
  currentStatus: IncidentStatus,
  notes?: string,
  gpsLatitude?: number,
  gpsLongitude?: number
): Promise<void> => {
  const timestamp = new Date().toISOString();

  const updates: Record<string, unknown> = {
    status: newStatus,
    status_updated_by: updatedBy,
    status_updated_at: timestamp,
    updated_at: timestamp,
  };

  const q = query(
    collection(firestore, INCIDENTS_COLLECTION),
    where('incident_id', '==', incidentId)
  );
  const snap = await getDocs(q);
  const incidentRef = !snap.empty
    ? snap.docs[0].ref
    : doc(collection(firestore, INCIDENTS_COLLECTION), incidentId);

  switch (newStatus) {
    case 'EnRoute':
      updates.en_route_at = timestamp;
      break;

    case 'OnScene': {
      updates.on_scene_at = timestamp;
      const snapshot = await getDoc(incidentRef);
      const incident = snapshot.exists()
        ? (snapshot.data() as Record<string, unknown>)
        : null;
      const reported =
        incident?.reported_at ?? incident?.timestamp ?? incident?.created_at;
      if (reported != null) {
        const reportedTime = new Date(
          typeof reported === 'number' ? reported : (reported as string)
        ).getTime();
        const onSceneTime = new Date(timestamp).getTime();
        updates.response_time_seconds = Math.max(
          0,
          Math.floor((onSceneTime - reportedTime) / 1000)
        );
      }
      break;
    }

    case 'Resolved': {
      updates.resolved_at = timestamp;
      updates.resolved_notes = notes || null;

      const resolvedUnitQuery = query(
        collection(firestore, INCIDENT_UNITS_COLLECTION),
        where('assigned_incident_id', '==', incidentId)
      );
      const resolvedUnitSnap = await getDocs(resolvedUnitQuery);
      for (const unitDoc of resolvedUnitSnap.docs) {
        await updateDoc(unitDoc.ref, {
          status: 'Available',
          assigned_incident_id: null,
          last_update: timestamp,
        });
      }
      break;
    }

    case 'Cancelled': {
      updates.cancelled_reason = notes || null;

      const cancelledUnitQuery = query(
        collection(firestore, INCIDENT_UNITS_COLLECTION),
        where('assigned_incident_id', '==', incidentId)
      );
      const cancelledUnitSnap = await getDocs(cancelledUnitQuery);
      for (const unitDoc of cancelledUnitSnap.docs) {
        await updateDoc(unitDoc.ref, {
          status: 'Available',
          assigned_incident_id: null,
          last_update: timestamp,
        });
      }
      break;
    }
  }

  await updateDoc(incidentRef, updates);

  await addDoc(collection(firestore, HISTORY_COLLECTION), {
    incident_id: incidentId,
    status_from: currentStatus,
    status_to: newStatus,
    updated_by: updatedBy,
    updated_at: timestamp,
    notes: notes || null,
    gps_latitude: gpsLatitude ?? null,
    gps_longitude: gpsLongitude ?? null,
    created_at: serverTimestamp(),
  });
};

// ============================================================
// ⭐ NEW — hideIncidentFromDispatcher
//    Marks the incident as hidden for the dispatcher map.
//    The Firestore document is NEVER deleted — Admin still sees it.
// ============================================================
export const hideIncidentFromDispatcher = async (
  incidentId: string,
  hiddenBy: string,
  hiddenByName: string,
  reason?: string
): Promise<void> => {
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = {
    hidden_from_dispatcher: true,
    hidden_at: now,
    hidden_by: hiddenBy,
    hidden_by_name: hiddenByName,
    hidden_reason: reason || null,
    updated_at: now,
  };

  const q = query(
    collection(firestore, INCIDENTS_COLLECTION),
    where('incident_id', '==', incidentId)
  );
  const snap = await getDocs(q);

  if (!snap.empty) {
    for (const d of snap.docs) {
      await updateDoc(d.ref, updates);
    }
  } else {
    await updateDoc(
      doc(collection(firestore, INCIDENTS_COLLECTION), incidentId),
      updates
    );
  }

  // Release any units assigned to this incident
  const assignedQuery = query(
    collection(firestore, INCIDENT_UNITS_COLLECTION),
    where('assigned_incident_id', '==', incidentId)
  );
  const assignedSnap = await getDocs(assignedQuery);
  for (const unitDoc of assignedSnap.docs) {
    await updateDoc(unitDoc.ref, {
      status: 'Available',
      assigned_incident_id: null,
      last_update: now,
    });
  }

  // Log to history (doc still exists)
  await addDoc(collection(firestore, HISTORY_COLLECTION), {
    incident_id: incidentId,
    status_from: 'HiddenFromDispatcher',
    status_to: 'HiddenFromDispatcher',
    updated_by: hiddenBy,
    updated_at: now,
    notes: reason || `Hidden from dispatcher by ${hiddenByName}`,
    gps_latitude: null,
    gps_longitude: null,
    created_at: serverTimestamp(),
  });
};

// ============================================================
// ⭐ NEW — hideAllIncidentsFromDispatcher (bulk)
// ============================================================
export const hideAllIncidentsFromDispatcher = async (
  incidentIds: string[],
  hiddenBy: string,
  hiddenByName: string,
  reason?: string
): Promise<{ hidden: number; failed: string[] }> => {
  const failed: string[] = [];
  let hidden = 0;

  for (const id of incidentIds) {
    try {
      await hideIncidentFromDispatcher(id, hiddenBy, hiddenByName, reason);
      hidden++;
      await new Promise((r) => setTimeout(r, 80));
    } catch (err) {
      console.error(`Failed to hide ${id}:`, err);
      failed.push(id);
    }
  }

  return { hidden, failed };
};

// ============================================================
// deleteIncident — HARD delete. Only used by Admin.
// (Dispatcher no longer calls this — it calls hideIncidentFromDispatcher.)
// ============================================================
export const deleteIncident = async (incidentId: string): Promise<void> => {
  try {
    await deleteDoc(
      doc(collection(firestore, INCIDENTS_COLLECTION), incidentId)
    );
  } catch (err) {
    console.warn('Direct delete by doc id failed, trying query:', err);
  }

  try {
    const q = query(
      collection(firestore, INCIDENTS_COLLECTION),
      where('incident_id', '==', incidentId)
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) {
      await deleteDoc(d.ref);
    }
  } catch (err) {
    console.warn('Query delete by incident_id failed:', err);
  }

  const historyQuery = query(
    collection(firestore, HISTORY_COLLECTION),
    where('incident_id', '==', incidentId)
  );
  const historySnap = await getDocs(historyQuery);
  for (const historyDoc of historySnap.docs) {
    await deleteDoc(historyDoc.ref);
  }

  const assignedQuery = query(
    collection(firestore, INCIDENT_UNITS_COLLECTION),
    where('assigned_incident_id', '==', incidentId)
  );
  const assignedSnap = await getDocs(assignedQuery);
  for (const unitDoc of assignedSnap.docs) {
    await updateDoc(unitDoc.ref, {
      status: 'Available',
      assigned_incident_id: null,
      last_update: new Date().toISOString(),
    });
  }
};

// ============================================================
// subscribeToIncidentHistory — unchanged
// ============================================================
export const subscribeToIncidentHistory = (
  incidentId: string,
  callback: (history: IncidentStatusHistory[]) => void
): (() => void) => {
  const historyRef = collection(firestore, HISTORY_COLLECTION);
  const historyQuery = query(
    historyRef,
    where('incident_id', '==', incidentId),
    orderBy('updated_at', 'desc')
  );

  return onSnapshot(
    historyQuery,
    (snapshot: QuerySnapshot) => {
      const incidentHistory: IncidentStatusHistory[] = snapshot.docs.map(
        (docSnapshot: DocumentSnapshot) => {
          const data = docSnapshot.data() as Record<string, unknown>;
          return {
            history_id: docSnapshot.id,
            incident_id: (data.incident_id as string) || '',
            status_from: (data.status_from as string) || '',
            status_to: (data.status_to as string) || '',
            updated_by: (data.updated_by as string) || '',
            updated_at: fromAppOrDate(data.updated_at),
            notes: (data.notes as string) || null,
            gps_latitude: (data.gps_latitude as number) || null,
            gps_longitude: (data.gps_longitude as number) || null,
          };
        }
      );
      callback(incidentHistory);
    },
    (error: Error) => {
      console.error('Error loading incident history:', error);
      callback([]);
    }
  );
};

// ============================================================
// getRecentIncidents — unchanged
// ============================================================
export const getRecentIncidents = async (
  limitCount: number = 20
): Promise<Incident[]> => {
  const incidentsRef = collection(firestore, INCIDENTS_COLLECTION);
  const snapshot = await getDocs(incidentsRef);

  const incidents: Incident[] = snapshot.docs.map((docSnapshot: DocumentSnapshot) =>
    mapIncident(docSnapshot.data() as Record<string, unknown>, docSnapshot.id)
  );

  return incidents
    .sort(
      (a, b) =>
        new Date(b.reported_at).getTime() - new Date(a.reported_at).getTime()
    )
    .slice(0, limitCount);
};

export type { IncidentUpdates };