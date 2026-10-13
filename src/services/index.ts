// src/services/index.ts
// Export firebase first
export {
  auth,
  firestore,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  deleteUser,
  updateEmail,
  updatePassword,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  limitToLast,
  serverTimestamp,
  isFirebaseConfigured,
  type User,
  type UserCredential,
  type Unsubscribe,
  type Firestore,
  type DocumentData,
  type DocumentSnapshot,
  type QuerySnapshot,
  type Query,
} from './firebase';

// Export services
export {
  INCIDENTS_COLLECTION,
  HISTORY_COLLECTION,
  INCIDENT_UNITS_COLLECTION,
  DISPATCHES_COLLECTION,
  createIncident,
  subscribeToIncidents,
  subscribeToIncident,
  verifyIncident,
  dispatchUnits,
  updateIncidentStatus,
  deleteIncident,
  subscribeToIncidentHistory,
  getRecentIncidents,
  type IncidentStatus,
  type IncidentUpdates,
} from './incidentService';

export {
  UNITS_COLLECTION,
  UNIT_HISTORY_COLLECTION,
  createUnit,
  subscribeToUnits,
  subscribeToUnit,
  updateUnitStatus,
  updateUnitLocation,
  updateUnitDetails,
  deleteUnit,
  calculateETA,
  getAllUnits,
  type UnitStatus,
  type UnitUpdates,
} from './unitService';

export {
  SENSORS_COLLECTION,
  READINGS_COLLECTION,
  createSensor,
  subscribeToSensors,
  subscribeToSensor,
  updateSensor,
  deleteSensor,
  addSensorReading,
  subscribeToSensorReadings,
  subscribeToAllSensorReadings,
  getAllSensors,
} from './sensorService';

// Export sync and bridge
export { SyncService, default as SyncServiceDefault } from './syncService';
export { mobileBridge, default as MobileBridge } from './mobileBridge';