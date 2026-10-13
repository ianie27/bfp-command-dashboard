// src/services/syncService.ts
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
  type QuerySnapshot,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from './firebase';
import type { Incident, ResponseUnit, IoTSensor } from '../types';

// Collection names matching mobile app
export const FIRE_REPORTS_COLLECTION = 'fire_reports';
export const RESPONSE_UNITS_COLLECTION = 'response_units';
export const IOT_SENSORS_COLLECTION = 'iot_sensors';
export const USERS_COLLECTION = 'users';
export const BFP_PERSONNEL_COLLECTION = 'bfp_personnel';
export const EMERGENCY_CONTACTS_COLLECTION = 'emergency_contacts';
export const DEVICES_COLLECTION = 'devices';
export const LOGIN_HISTORY_COLLECTION = 'login_history';
export const REPORTS_COLLECTION = 'reports';
export const SAVED_LOCATIONS_COLLECTION = 'saved_locations';
export const TRUCK_LOCATIONS_COLLECTION = 'truck_locations';
export const DISPATCHES_COLLECTION = 'dispatches';
export const INCIDENT_HISTORY_COLLECTION = 'incident_status_history';
export const NOTIFICATIONS_COLLECTION = 'notifications';

// Sync service to bridge dashboard and mobile app
export class SyncService {
  private static instance: SyncService;
  
  private constructor() {}
  
  public static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }
    return SyncService.instance;
  }

  // Sync incidents from mobile app to dashboard
  public syncIncidentsFromMobile(callback: (incidents: Incident[]) => void): () => void {
    const incidentsRef = collection(firestore, FIRE_REPORTS_COLLECTION);
    
    return onSnapshot(
      incidentsRef,
      (snapshot: QuerySnapshot) => {
        const incidents: Incident[] = snapshot.docs.map((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as Record<string, unknown>;
          return this.mapMobileIncidentToDashboard(data, doc.id);
        });
        callback(incidents);
      },
      (error: Error) => {
        console.error('Error syncing incidents from mobile:', error);
        callback([]);
      }
    );
  }

  // Sync units from mobile app to dashboard
  public syncUnitsFromMobile(callback: (units: ResponseUnit[]) => void): () => void {
    const unitsRef = collection(firestore, RESPONSE_UNITS_COLLECTION);
    
    return onSnapshot(
      unitsRef,
      (snapshot: QuerySnapshot) => {
        const units: ResponseUnit[] = snapshot.docs.map((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as Record<string, unknown>;
          return this.mapMobileUnitToDashboard(data, doc.id);
        });
        callback(units);
      },
      (error: Error) => {
        console.error('Error syncing units from mobile:', error);
        callback([]);
      }
    );
  }

  // Sync sensors from mobile app to dashboard
  public syncSensorsFromMobile(callback: (sensors: IoTSensor[]) => void): () => void {
    const sensorsRef = collection(firestore, IOT_SENSORS_COLLECTION);
    
    return onSnapshot(
      sensorsRef,
      (snapshot: QuerySnapshot) => {
        const sensors: IoTSensor[] = snapshot.docs.map((doc: QueryDocumentSnapshot) => {
          const data = doc.data() as Record<string, unknown>;
          return this.mapMobileSensorToDashboard(data, doc.id);
        });
        callback(sensors);
      },
      (error: Error) => {
        console.error('Error syncing sensors from mobile:', error);
        callback([]);
      }
    );
  }

  // Map mobile incident to dashboard format
  private mapMobileIncidentToDashboard(data: Record<string, unknown>, id: string): Incident {
    const fromAppOrDate = (value: unknown): string => {
      if (value === null || value === undefined || value === '') return new Date().toISOString();
      if (typeof value === 'number') return new Date(value).toISOString();
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'string') {
        const d = new Date(value);
        return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      }
      return new Date().toISOString();
    };

    const mapStatus = (status: unknown): Incident['status'] => {
      if (typeof status !== 'string') return 'Received';
      if (status === 'initiated') return 'Received';
      if (status === 'ended') return 'Resolved';
      if (['Received', 'Verified', 'Dispatched', 'EnRoute', 'OnScene', 'Resolved', 'Cancelled'].includes(status)) {
        return status as Incident['status'];
      }
      return 'Received';
    };

    const reportedAt = fromAppOrDate(data.timestamp ?? data.reportedAt ?? data.createdAt);
    const endedAt = data.endTimestamp != null ? fromAppOrDate(data.endTimestamp) : null;

    return {
      incident_id: (data.reportId as string) || id,
      citizen_reporter: (data.userId as string) || null,
      guest_reporter: !data.userId,
      source: data.source === 'iot_sensor' ? 'iot_sensor' : 'citizen',
      iot_sensor_id: (data.iot_sensor_id as string) || null,
      latitude: typeof data.latitude === 'number' ? data.latitude : 0,
      longitude: typeof data.longitude === 'number' ? data.longitude : 0,
      location_address: (data.address as string) || (data.location as string) || null,
      reported_at: reportedAt,
      threat_level: data.threat_level === 'RED' ? 'RED' : 'YELLOW',
      status: mapStatus(data.status as string),
      description: (data.description as string) || (data.type as string) || null,
      fire_intensity: (data.fire_intensity as Incident['fire_intensity']) || null,
      verified_by: (data.verified_by as string) || null,
      verified_at: (data.verified_at as string) || null,
      dispatched_at: (data.dispatched_at as string) || null,
      en_route_at: (data.en_route_at as string) || null,
      on_scene_at: (data.on_scene_at as string) || null,
      resolved_at: (data.resolved_at as string) || endedAt,
      resolved_notes: (data.resolved_notes as string) || (data.duration != null ? `Call duration: ${data.duration}s` : null),
      cancelled_reason: (data.cancelled_reason as string) || null,
      is_duplicate: data.is_duplicate === true,
      duplicate_of: (data.duplicate_of as string) || null,
      response_time_seconds: typeof data.response_time_seconds === 'number' ? data.response_time_seconds : null,
    };
  }

  // Map mobile unit to dashboard format
  private mapMobileUnitToDashboard(data: Record<string, unknown>, id: string): ResponseUnit {
    return {
      unit_id: (data.unit_id as string) || id,
      unit_name: (data.unit_name as string) || 'Unknown Unit',
      unit_code: (data.unit_code as string) || id,
      status: (data.status as ResponseUnit['status']) || 'Available',
      latitude: typeof data.latitude === 'number' ? data.latitude : 0,
      longitude: typeof data.longitude === 'number' ? data.longitude : 0,
      speed: typeof data.speed === 'number' ? data.speed : 0,
      heading: typeof data.heading === 'number' ? data.heading : 0,
      assigned_incident_id: (data.assigned_incident_id as string) || (data.reportId as string) || null,
      eta_seconds: typeof data.eta_seconds === 'number' ? data.eta_seconds : 0,
      last_update: data.last_update ? new Date(data.last_update as string).toISOString() : new Date().toISOString(),
      crew_info: Array.isArray(data.crew_info) ? data.crew_info as ResponseUnit['crew_info'] : [],
      fuel_level: typeof data.fuel_level === 'number' ? data.fuel_level : 100,
    };
  }

  // Map mobile sensor to dashboard format
  private mapMobileSensorToDashboard(data: Record<string, unknown>, id: string): IoTSensor {
    return {
      sensor_id: (data.sensor_id as string) || id,
      location: (data.location as string) || 'Unknown location',
      latitude: typeof data.latitude === 'number' ? data.latitude : 0,
      longitude: typeof data.longitude === 'number' ? data.longitude : 0,
      sensor_type: (data.sensor_type as IoTSensor['sensor_type']) || 'Smoke',
      status: (data.status as IoTSensor['status']) || 'Offline',
      battery_level: typeof data.battery_level === 'number' ? data.battery_level : 0,
      last_heartbeat: data.last_heartbeat ? new Date(data.last_heartbeat as string).toISOString() : new Date().toISOString(),
      installed_at: data.installed_at ? new Date(data.installed_at as string).toISOString() : new Date().toISOString(),
    };
  }

  // Dispatch command to mobile app
  public async dispatchToMobile(incidentId: string, unitIds: string[], dispatcherId: string): Promise<void> {
    const timestamp = new Date().toISOString();

    // Update incident status
    await updateDoc(doc(collection(firestore, FIRE_REPORTS_COLLECTION), incidentId), {
      status: 'Dispatched',
      dispatched_at: timestamp,
      dispatched_units: unitIds,
    });

    // Update units
    for (const unitId of unitIds) {
      const unitRef = doc(collection(firestore, RESPONSE_UNITS_COLLECTION), unitId);
      await setDoc(unitRef, {
        unit_id: unitId,
        status: 'Dispatched',
        assigned_incident_id: incidentId,
        last_update: timestamp,
      }, { merge: true });
    }

    // Create dispatch record
    await addDoc(collection(firestore, DISPATCHES_COLLECTION), {
      incident_id: incidentId,
      unit_ids: unitIds,
      dispatched_by: dispatcherId,
      dispatched_at: timestamp,
      created_at: serverTimestamp(),
    });
  }

  // Update incident status (syncs to mobile app)
  public async updateIncidentStatus(
    incidentId: string,
    newStatus: string,
    updatedBy: string,
    notes?: string
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const incidentRef = doc(collection(firestore, FIRE_REPORTS_COLLECTION), incidentId);

    const updates: Record<string, unknown> = {
      status: newStatus,
      status_updated_by: updatedBy,
      status_updated_at: timestamp,
    };

    // Add status-specific timestamps
    switch (newStatus) {
      case 'EnRoute':
        updates.en_route_at = timestamp;
        break;
      case 'OnScene':
        updates.on_scene_at = timestamp;
        break;
      case 'Resolved':
        updates.resolved_at = timestamp;
        updates.resolved_notes = notes || null;
        break;
      case 'Cancelled':
        updates.cancelled_reason = notes || null;
        break;
    }

    await updateDoc(incidentRef, updates);

    // Record in history
    await addDoc(collection(firestore, INCIDENT_HISTORY_COLLECTION), {
      incident_id: incidentId,
      status_from: 'Received',
      status_to: newStatus,
      updated_by: updatedBy,
      updated_at: timestamp,
      notes: notes || null,
      created_at: serverTimestamp(),
    });
  }

  // Get mobile users (for personnel management)
  public async getMobileUsers(): Promise<Record<string, unknown>[]> {
    const usersRef = collection(firestore, USERS_COLLECTION);
    const snapshot = await getDocs(usersRef);
    return snapshot.docs.map((doc: QueryDocumentSnapshot) => ({ 
      id: doc.id, 
      ...doc.data() as Record<string, unknown> 
    }));
  }

  // Get BFP personnel (for personnel management)
  public async getBFPPersonnel(): Promise<Record<string, unknown>[]> {
    const personnelRef = collection(firestore, BFP_PERSONNEL_COLLECTION);
    const snapshot = await getDocs(personnelRef);
    return snapshot.docs.map((doc: QueryDocumentSnapshot) => ({ 
      id: doc.id, 
      ...doc.data() as Record<string, unknown> 
    }));
  }
}

export default SyncService;