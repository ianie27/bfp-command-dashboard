// src/contexts/AuthProvider.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, firestore } from '../services/firebase';
import { AuthContext } from './AuthContext';
import type { BFPPersonnel, AuthState } from '../types';
import { extractRole, normalizeRole } from '../utils/roles';

interface AuthProviderProps {
  children: React.ReactNode;
}

// ============================================================
// Fallback role inference — only used when a Firestore doc
// exists but its role field is empty.
// ============================================================
const inferRoleFromEmail = (email: string | null | undefined): string => {
  if (!email) return '';
  const lower = email.toLowerCase();
  if (lower.includes('admin')) return 'Administrator';
  if (lower.includes('dispatcher')) return 'Dispatcher';
  if (lower.includes('coordinator')) return 'Coordinator';
  if (lower.includes('responder')) return 'Responder';
  if (lower.includes('iot') || lower.includes('technician'))
    return 'IoT_Technician';
  return '';
};

const COLLECTIONS = [
  'personnel',
  'users',
  'bfp_personnel',
  'bfpPersonnel',
  'staff',
  'accounts',
];

const EMAIL_FIELDS = ['email', 'emailAddress', 'userEmail', 'user_email'];

const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<BFPPersonnel | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // ---------- Fetch personnel record from Firestore ----------
  const fetchPersonnel = useCallback(
    async (fbUser: FirebaseUser): Promise<BFPPersonnel | null> => {
      const uid = fbUser.uid;
      const email = (fbUser.email || '').toLowerCase();

      const report: Array<{ collection: string; docId: string; data: any }> =
        [];

      const tryDocById = async (collectionName: string, docId: string) => {
        try {
          const snap = await getDoc(doc(firestore, collectionName, docId));
          if (!snap.exists()) return null;

          const data = snap.data() as any;
          report.push({ collection: collectionName, docId: snap.id, data });

          const rawRole = extractRole(data);
          const role = rawRole || inferRoleFromEmail(email);

          if (!role) {
            console.warn(
              `⚠️ [Auth] ${collectionName}/${snap.id} exists but no recognized role field. ` +
                `Keys=[${Object.keys(data).join(', ')}]`
            );
            return null;
          }

          if (!rawRole) {
            console.warn(
              `⚠️ [Auth] ${collectionName}/${snap.id} had no role field; ` +
                `inferred "${role}" from email.`
            );
          } else {
            console.log(
              `✅ [Auth] MATCH via ${collectionName}/${snap.id} → role="${role}"`
            );
          }

          return { uid, ...data, role } as BFPPersonnel;
        } catch (err) {
          console.warn(
            `⚠️ [Auth] getDoc(${collectionName}/${docId}) failed:`,
            err
          );
          return null;
        }
      };

      const tryQueryByField = async (
        collectionName: string,
        field: string,
        value: string
      ) => {
        try {
          const q = query(
            collection(firestore, collectionName),
            where(field, '==', value),
            limit(1)
          );
          const snap = await getDocs(q);
          if (snap.empty) return null;

          const docSnap = snap.docs[0];
          const data = docSnap.data() as any;
          report.push({ collection: collectionName, docId: docSnap.id, data });

          const rawRole = extractRole(data);
          const role = rawRole || inferRoleFromEmail(email);

          if (!role) {
            console.warn(
              `⚠️ [Auth] ${collectionName}.where("${field}"=="${value}") ` +
                `found doc=${docSnap.id} but no recognized role. ` +
                `Keys=[${Object.keys(data).join(', ')}]`
            );
            return null;
          }

          console.log(
            `✅ [Auth] MATCH via ${collectionName}.where("${field}"=="${value}") ` +
              `doc=${docSnap.id} → role="${role}"`
          );

          return {
            uid,
            ...data,
            personnel_id:
              (data as any).personnel_id ||
              (data as any).user_id ||
              docSnap.id,
            role,
          } as BFPPersonnel;
        } catch {
          // Firestore throws if the field doesn't exist on any doc
          // — that's expected; skip silently.
          return null;
        }
      };

      // ── 1) Match by document id === Firebase Auth uid
      for (const c of COLLECTIONS) {
        const hit = await tryDocById(c, uid);
        if (hit) return hit;
      }

      // ── 2) Match by any of the email-like fields
      if (email) {
        for (const c of COLLECTIONS) {
          for (const f of EMAIL_FIELDS) {
            const hit = await tryQueryByField(c, f, email);
            if (hit) return hit;
          }
        }
      }

      // ── 3) Nothing matched — dump what we saw for debugging
      console.error(
        `❌ [Auth] No personnel record with a recognized role for ` +
          `uid="${uid}" email="${email}".`
      );
      console.error(
        `   Collections tried: ${COLLECTIONS.join(', ')}`
      );
      console.error(
        `   Email fields tried: ${EMAIL_FIELDS.join(', ')}`
      );
      console.error(`   Docs inspected: ${report.length}`);
      report.forEach((r) => {
        console.error(
          `   • ${r.collection}/${r.docId} → keys=[${Object.keys(r.data).join(', ')}]`,
          r.data
        );
      });

      return null;
    },
    []
  );

  // ---------- Subscribe to Firebase Auth ----------
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      try {
        if (fbUser) {
          const personnel = await fetchPersonnel(fbUser);

          console.log(
            '🎯 [Auth] onAuthStateChanged → FINAL USER:',
            personnel
          );
          console.log(
            '🎯 [Auth] Extracted role:',
            personnel ? extractRole(personnel) : '(none)'
          );

          setUser(personnel);

          // Hard fail: no role → sign out so we never route blind
          if (!personnel || !extractRole(personnel)) {
            console.warn(
              '🚪 [Auth] No resolvable role — signing out to prevent mis-routing.'
            );
            try {
              await signOut(auth);
            } catch (e) {
              console.warn('signOut after role-fail failed:', e);
            }
            setUser(null);
          }
        } else {
          console.log('🔒 [Auth] onAuthStateChanged → no user');
          setUser(null);
        }
      } catch (err) {
        console.error('❌ [Auth] onAuthStateChanged error:', err);
        setUser(null);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [fetchPersonnel]);

  // ---------- Login ----------
  const login = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<boolean> => {
      try {
        const result = await signInWithEmailAndPassword(
          auth,
          credentials.email,
          credentials.password
        );

        const personnel = await fetchPersonnel(result.user);

        if (!personnel) {
          console.error(
            '❌ [Auth] Login succeeded but no personnel record found.'
          );
          await signOut(auth);
          setUser(null);
          return false;
        }

        if (!extractRole(personnel)) {
          console.error(
            '❌ [Auth] Personnel record has no resolvable role.'
          );
          await signOut(auth);
          setUser(null);
          return false;
        }

        setUser(personnel);
        return true;
      } catch (err) {
        console.error('❌ [Auth] Login failed:', err);
        return false;
      }
    },
    [fetchPersonnel]
  );

  // ---------- Logout ----------
  const logout = useCallback(async (): Promise<void> => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error('❌ [Auth] Logout failed:', err);
    } finally {
      setUser(null);
      try {
        localStorage.removeItem('user');
        sessionStorage.removeItem('user');
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    }
  }, []);

  // ---------- Permission check ----------
  const hasPermission = useCallback(
    (requiredRoles: string[]): boolean => {
      if (!user) return false;
      if (!requiredRoles || requiredRoles.length === 0) return true;

      const rawRole = extractRole(user);
      const userRole = normalizeRole(rawRole);

      if (!userRole) {
        console.warn('⚠️ [Auth] hasPermission: user has no role.', user);
        return false;
      }

      // Admin bypass
      if (userRole === 'administrator' || userRole === 'admin') {
        return true;
      }

      const allowed = requiredRoles.map(normalizeRole).includes(userRole);

      if (!allowed) {
        console.warn(
          `⛔ [Auth] Access denied. role="${rawRole}" not in [${requiredRoles.join(
            ', '
          )}]`
        );
      }
      return allowed;
    },
    [user]
  );

  // ---------- Audit log ----------
  const logActivity = useCallback(
    async (
      action: string,
      entityType?: string,
      entityId?: string | null,
      status: 'success' | 'failure' = 'success',
      errorMessage: string | null = null
    ): Promise<void> => {
      try {
        if (!user) return;
        await addDoc(collection(firestore, 'audit_logs'), {
          action,
          entity_type: entityType || null,
          entity_id: entityId || null,
          actor_id: user.uid,
          actor_name:
            (user as any).displayName ||
            (user as any).full_name ||
            (user as any).email ||
            'Unknown',
          actor_role: extractRole(user) || 'Unknown',
          status,
          error_message: errorMessage,
          timestamp: serverTimestamp(),
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('⚠️ [Auth] logActivity failed (non-fatal):', err);
      }
    },
    [user]
  );

  // ---------- Create user ----------
  const createUser = useCallback(
    async (
      userData: Partial<BFPPersonnel>,
      password: string
    ): Promise<boolean> => {
      try {
        if (!userData.email) throw new Error('Email is required');
        const cred = await createUserWithEmailAndPassword(
          auth,
          userData.email,
          password
        );

        if (userData.displayName) {
          await updateProfile(cred.user, {
            displayName: userData.displayName,
          });
        }

        await setDoc(doc(firestore, 'personnel', cred.user.uid), {
          ...userData,
          uid: cred.user.uid,
          email: userData.email,
          role: userData.role || 'Dispatcher',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        await logActivity('create_user', 'personnel', cred.user.uid);
        return true;
      } catch (err) {
        console.error('❌ [Auth] createUser failed:', err);
        await logActivity(
          'create_user',
          'personnel',
          null,
          'failure',
          (err as Error).message
        );
        return false;
      }
    },
    [logActivity]
  );

  // ---------- Update user ----------
  const updateUser = useCallback(
    async (
      userId: string,
      updates: Partial<BFPPersonnel>
    ): Promise<boolean> => {
      try {
        await updateDoc(doc(firestore, 'personnel', userId), {
          ...updates,
          updatedAt: serverTimestamp(),
        });
        await logActivity('update_user', 'personnel', userId);
        return true;
      } catch (err) {
        console.error('❌ [Auth] updateUser failed:', err);
        await logActivity(
          'update_user',
          'personnel',
          userId,
          'failure',
          (err as Error).message
        );
        return false;
      }
    },
    [logActivity]
  );

  // ---------- Reset password ----------
  const resetPassword = useCallback(
    async (email: string): Promise<boolean> => {
      try {
        await sendPasswordResetEmail(auth, email);
        await logActivity('reset_password', 'personnel', null);
        return true;
      } catch (err) {
        console.error('❌ [Auth] resetPassword failed:', err);
        await logActivity(
          'reset_password',
          'personnel',
          null,
          'failure',
          (err as Error).message
        );
        return false;
      }
    },
    [logActivity]
  );

  // ---------- Memoize context ----------
  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      hasPermission,
      logActivity,
      createUser,
      updateUser,
      resetPassword,
    }),
    [
      user,
      loading,
      login,
      logout,
      hasPermission,
      logActivity,
      createUser,
      updateUser,
      resetPassword,
    ]
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
};

export default AuthProvider;