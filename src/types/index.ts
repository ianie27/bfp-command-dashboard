// ============================================================
//  types.ts — v25
//  + Owner / administrator metadata on IoTSensor
//  + Aliases used by the admin Add Sensor form (name, phone)
//  + IoTAlarmEvent now carries admin metadata for dispatcher UI
// ============================================================

// ============================================================
//  User Management Types
// ============================================================
export interface BFPPersonnel {
  personnel_id: string;
  uid?: string;
  username: string;
  full_name: string;
  displayName?: string;
  name?: string;
  email: string;
  mobile_number: string;
  role: 'Dispatcher' | 'Administrator' | 'Responder' | 'Coordinator' | 'IoT_Technician';
  userRole?: string;
  station_assignment: string;
  permission_level: number;
  account_status: 'Active' | 'Inactive';
  mfa_enabled: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: any;
}

export interface CitizenUser {
  user_id: string;
  full_name: string;
  email: string;
  mobile_number: string;
  address: string;
  account_status: 'Active' | 'Suspended' | 'Banned';
  email_verified: boolean;
  created_at: string;
  last_login: string;
}

// ============================================================
//  Incident Management Types
// ============================================================
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

export type IncidentThreatLevel = 'RED' | 'YELLOW' | null;

export type IncidentSource =
  | 'citizen'
  | 'iot_sensor'
  | 'mobile_app'
  | string;

export interface Incident {
  incident_id: string;
  citizen_reporter: string | null;
  guest_reporter: boolean;
  source: IncidentSource;

  // Sensor-origin metadata
  iot_sensor_id: string | null;
  sensor_id?: string | null;
  sensor_type?: string | null;

  latitude: number;
  longitude: number;
  location_address: string | null;

  // Human-readable location fields passed through from the sensor doc
  building?: string | null;
  room?: string | null;
  floor?: string | null;
  temperature?: number | null;

  reported_at: string;
  threat_level: IncidentThreatLevel;
  status: IncidentStatus;

  description: string | null;
  fire_intensity: 'mild' | 'moderate' | 'severe' | null;

  // Lifecycle timestamps
  verified_by: string | null;
  verified_at: string | null;
  verified_by_name?: string | null;
  dispatched_at: string | null;
  en_route_at: string | null;
  on_scene_at: string | null;
  resolved_at: string | null;
  resolved_notes: string | null;
  resolved_by_unit?: string | null;
  cancelled_reason: string | null;

  is_duplicate: boolean;
  duplicate_of: string | null;
  response_time_seconds: number | null;

  // Caller / mobile-emergency linkage
  caller_name?: string;
  caller_phone?: string;
  emergency_id?: string;
  emergency_call_id?: string;

  // ------------------------------------------------------------
  // ⭐ Owner / administrator metadata
  //   Copied from the sensor document when an IoT incident is
  //   created, so the dispatcher can reach the property owner
  //   without opening the sensor doc.
  // ------------------------------------------------------------
  admin_name?: string | null;
  admin_phone?: string | null;
  admin_email?: string | null;
  admin_address?: string | null;
  admin_role?: string | null;
  admin_emergency?: string | null;

  // Common metadata
  created_at?: string;
  updated_at?: string;
  dispatcher_name?: string;
  acknowledged?: boolean;

  // ------------------------------------------------------------
  // Dispatcher hide-only flags
  // ------------------------------------------------------------
  hidden_from_dispatcher?: boolean;
  hidden_at?: string | null;
  hidden_by?: string | null;
  hidden_by_name?: string | null;
  hidden_reason?: string | null;
}

export interface IncidentStatusHistory {
  history_id: string;
  incident_id: string;
  status_from: string;
  status_to: string;
  updated_by: string;
  updated_at: string;
  notes: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
}

// ============================================================
//  Response Unit Types
// ============================================================
export type ResponseUnitStatus =
  | 'Available'
  | 'Dispatched'
  | 'EnRoute'
  | 'OnScene'
  | 'OffDuty';

export interface ResponseUnit {
  unit_id: string;
  unit_name: string;
  unit_code: string;
  status: ResponseUnitStatus;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  assigned_incident_id: string | null;
  current_incident_id?: string | null;
  eta_seconds: number;
  last_update: string;
  crew_info: CrewMember[];
  fuel_level: number;

  is_online?: boolean;
  last_active?: number | string;
  location_name?: string;
  building?: string;
  room?: string;
  floor?: string;
  provider?: string;
  accuracy?: number;
}

export interface CrewMember {
  name: string;
  role: string;
}

export interface UnitTrackingHistory {
  track_id: string;
  unit_id: string;
  latitude: number;
  longitude: number;
  status: string;
  recorded_at: string;
}

// ============================================================
//  IoT Sensor Types — v25
// ============================================================
//  These match the exact field names the ESP32 sketch writes.
//  NORMAL is a real state the ESP32 sends when nothing is
//  detected; it is NOT the same as null.
//
//  ⭐ v25 additions:
//     • Owner / administrator metadata (admin_*)
//     • Aliases written by the Admin Add Sensor form (name, phone)
//     • Explicit threat_level typing shared with the ESP32 firmware
// ============================================================

export type IoTSensorType =
  | 'Smoke'
  | 'Heat'
  | 'Flame'
  | 'Gas'
  | 'Multi'
  | 'Fire/Gas Detector'
  | 'fire_gas_sensor'
  | string;

export type IoTSensorStatus =
  | 'Active'
  | 'Maintenance'
  | 'Offline'
  | 'Normal'
  | 'Inactive'
  | string;

export type IoTSensorThreatLevel = 'RED' | 'YELLOW' | 'NORMAL' | null;

export interface IoTSensor {
  // ----- Base fields -----
  sensor_id: string;
  location: string;
  latitude: number;
  longitude: number;
  sensor_type: IoTSensorType;
  status: IoTSensorStatus;
  battery_level: number;
  last_heartbeat: string;
  installed_at: string;

  // ----- ESP32-published extras -----
  threat_level?: IoTSensorThreatLevel;
  location_name?: string;
  building?: string;
  room?: string;
  floor?: string;
  temperature?: number;
  humidity?: number;
  gas?: number;
  gas_baseline?: number;
  gasDOUT?: boolean;
  flame?: boolean;
  smoke?: boolean;
  buzzer?: boolean;
  last_seen?: string;
  last_update?: string;
  uptime?: number;
  timeSynced?: boolean;
  provider?: string;
  accuracy?: number;

  // ------------------------------------------------------------
  // ⭐ Owner / administrator metadata
  //   Written by the ESP32 on every telemetry packet. Displayed
  //   in the Sensor Details modal and the Incident detail panel
  //   so the dispatcher can contact the property owner.
  // ------------------------------------------------------------
  admin_name?: string;
  admin_phone?: string;
  admin_email?: string;
  admin_address?: string;
  admin_role?: string;
  admin_emergency?: string;

  // ------------------------------------------------------------
  // Aliases written by the Admin Add Sensor form (manual entry)
  //   These are only used as fallbacks when the ESP32 hasn't yet
  //   published its own admin_* fields.
  // ------------------------------------------------------------
  name?: string;
  phone?: string;

  // ----- Dispatcher-side state -----
  dispatcher_acknowledged?: boolean;
  dispatcher_acknowledged_at?: string;
  dispatcher_acknowledged_by?: string;
  dispatcher_acknowledged_by_name?: string;
  verified?: boolean;
  verified_at?: string;
  verified_by?: string;
  verified_by_name?: string;
  incident_id?: string;

  // ----- Dispatcher → ESP32 command flags -----
  commandSilence?: boolean;
  commandSilenceAt?: string;
  commandClear?: boolean;
  commandClearAt?: string;
  commandBuzzer?: boolean;
  commandBuzzerAt?: string;
  commandSilenceBy?: string;
  commandClearBy?: string;
  commandBuzzerBy?: string;
  commandSilenceByName?: string;
  commandClearByName?: string;
  commandBuzzerByName?: string;

  // ----- Common metadata -----
  created_at?: string;
  updated_at?: string;
}

export interface SensorReading {
  reading_id: string;
  sensor_id: string;
  smoke_ppm: number | null;
  temperature: number | null;
  flame_detected: boolean;
  flame_confidence: number | null;
  is_alert: boolean;
  read_at: string;
  received_at: string;
}

export interface IoTAlarmEvent {
  alarm_id: string;
  deviceId: string;
  alarmType: 'RED' | 'YELLOW' | 'RED_AND_YELLOW' | 'NONE' | string;
  status: 'ACTIVE' | 'CLEARED' | string;
  latitude: number;
  longitude: number;
  location_name?: string;
  building?: string;
  room?: string;
  floor?: string;
  gas_raw?: number;
  temperature?: number;
  humidity?: number;
  flame?: boolean;
  smoke?: boolean;

  // ⭐ Owner / administrator metadata copied from the sensor doc
  admin_name?: string;
  admin_phone?: string;
  admin_email?: string;
  admin_address?: string;
  admin_role?: string;
  admin_emergency?: string;

  triggered_at: string;
  timestamp: number;
}

// ============================================================
//  Report Types
// ============================================================
export interface GeneratedReport {
  report_id: string;
  report_type:
    | 'IncidentSummary'
    | 'ResponseTimeAnalysis'
    | 'ThreatLevelDistribution'
    | 'UnitUtilization'
    | 'CitizenActivity'
    | 'IoTPerformance';
  date_range_start: string;
  date_range_end: string;
  format: 'PDF' | 'Excel' | 'CSV';
  generated_by: string;
  generated_at: string;
  file_path: string;
}

// ============================================================
//  Audit Types
// ============================================================
export interface AuditLog {
  log_id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip_address: string | null;
  status: 'success' | 'failure';
  error_message: string | null;
  created_at: string;
  timestamp?: string;
}

// ============================================================
//  Notification Types
// ============================================================
export interface Notification {
  notification_id: string;
  user_id: string;
  user_type: 'citizen' | 'bfp_personnel';
  type: string;
  title: string;
  body: string;
  incident_id: string | null;
  read_status: boolean;
  delivery_status: 'pending' | 'sent' | 'delivered' | 'failed';
  channel?: 'push' | 'sms' | 'email' | 'in_app';
  created_at: string;
}

// ============================================================
//  Map Types
// ============================================================
export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  type: 'incident' | 'unit' | 'sensor';
  threat_level?: 'RED' | 'YELLOW';
  status?: string;
  title: string;
  popupContent: string;
}

export interface GeoMapFilters {
  showIncidents: boolean;
  showUnits: boolean;
  showSensors: boolean;
  threatLevelFilter: 'ALL' | 'RED' | 'YELLOW';
  unitStatusFilter: 'ALL' | ResponseUnitStatus;
  dateRange?: { start: Date; end: Date };
}

// ============================================================
//  Auth Types
// ============================================================
export interface AuthState {
  user: BFPPersonnel | null;
  loading: boolean;
  error?: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
  username?: string;
}

// ============================================================
//  Dashboard Stats
// ============================================================
export interface DashboardStats {
  totalActiveIncidents: number;
  highThreatIncidents: number;
  availableUnits: number;
  dispatchedUnits: number;
  averageResponseTime: number;
  sensorsOnline: number;
  sensorsOffline: number;
  incidentsToday: number;
  incidentsThisWeek: number;

  unacknowledgedRedSensors?: number;
  verifiedEmergencies?: number;
  unacknowledgedEmergencies?: number;
}