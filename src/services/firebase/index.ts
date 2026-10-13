// src/services/firebase/index.ts
// Barrel re-export — keeps `import { ... } from './firebase'` resolving here.
// Must mirror EVERY export from ./firebase, otherwise consumers break.

export {
  // ── App ────────────────────────────────────────────────────
  default as app,

  // ── Auth ───────────────────────────────────────────────────
  auth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  updateProfile,
  sendPasswordResetEmail,
  deleteUser,
  updateEmail,
  updatePassword,

  // ── Firestore instance ─────────────────────────────────────
  firestore,

  // ── Firestore functions ────────────────────────────────────
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
  Timestamp,        // ⭐ FIX: was missing
  arrayUnion,       // ⭐ FIX: was missing
  arrayRemove,      // ⭐ FIX: was missing
  writeBatch,       // ⭐ FIX: was missing
  runTransaction,   // ⭐ FIX: was missing
  increment,        // ⭐ FIX: was missing

  // ── Config helper ──────────────────────────────────────────
  isFirebaseConfigured,
} from './firebase';

// ── Type-only re-exports ─────────────────────────────────────
export type {
  User,
  UserCredential,
  Unsubscribe,
  Firestore,
  DocumentData,
  DocumentSnapshot,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Query,
  FirestoreUnsubscribe,
  FieldValue,       // ⭐ FIX: was missing
} from './firebase';