// src/utils/roles.ts
// ============================================================
// Central role utilities used by Login, ProtectedRoute, App,
// and AuthProvider. Keeping them in one place ensures the
// routing decision is identical everywhere.
// ============================================================

export const ROLE_FIELD_CANDIDATES: string[] = [
  'role',
  'userRole',
  'user_role',
  'position',
  'designation',
  'account_role',
  'accountRole',
  'roleName',
  'role_name',
  'userType',
  'user_type',
  'accessLevel',
  'access_level',
  'permission',
  'permissions',
];

export const NUMERIC_ROLE_MAP: Record<number, string> = {
  0: 'Administrator',
  1: 'Dispatcher',
  2: 'Responder',
  3: 'Coordinator',
  4: 'IoT_Technician',
};

/**
 * Extract a role string from ANY user object shape.
 * Tries top-level fields, nested `.role.name`, arrays, numeric
 * codes, and Firebase custom claims.
 * Returns '' if nothing is found.
 */
export const extractRole = (u: any): string => {
  if (!u || typeof u !== 'object') return '';

  // 1) Top-level string fields
  for (const f of ROLE_FIELD_CANDIDATES) {
    const val = u[f];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }

  // 2) Nested role object (e.g., { role: { name: 'Administrator' } })
  const nested = u?.role;
  if (nested && typeof nested === 'object') {
    for (const key of ['name', 'label', 'title', 'value', 'id']) {
      const v = nested[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  // 3) Array field (e.g., roles: ['Administrator'])
  for (const f of ROLE_FIELD_CANDIDATES) {
    const val = u[f];
    if (Array.isArray(val)) {
      const first = val.find((x) => typeof x === 'string' && x.trim());
      if (first) return String(first).trim();
    }
  }

  // 4) Numeric code on any field
  for (const f of ROLE_FIELD_CANDIDATES) {
    const val = u[f];
    if (typeof val === 'number' && NUMERIC_ROLE_MAP[val]) {
      return NUMERIC_ROLE_MAP[val];
    }
  }

  // 5) Firebase custom claims (if you attached them to the auth token)
  const claims = u?.claims || u?.customClaims;
  if (claims && typeof claims === 'object') {
    for (const f of ROLE_FIELD_CANDIDATES) {
      const v = claims[f];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }

  return '';
};

/**
 * Normalize a role string for comparison:
 *   "Administrator"  → "administrator"
 *   " DISPATCHER "   → "dispatcher"
 *   "IoT_Technician" → "iottechnician"
 *   "IoT Technician" → "iottechnician"
 */
export const normalizeRole = (role: unknown): string =>
  String(role ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');

export const isAdministrator = (u: any): boolean => {
  const n = normalizeRole(extractRole(u));
  return (
    n === 'administrator' ||
    n === 'admin' ||
    n === 'superadmin' ||
    n === 'sysadmin' ||
    n === 'systemadministrator'
  );
};

export const isDispatcher = (u: any): boolean => {
  const n = normalizeRole(extractRole(u));
  return n === 'dispatcher' || n === 'dispatch' || n === 'operator';
};

/**
 * Decide where a logged-in user should land.
 * Administrator → /admin/dashboard
 * Dispatcher    → /dispatcher
 * Anything else → /unauthorized
 */
export const resolveLandingRoute = (u: any): string => {
  if (isAdministrator(u)) return '/admin/dashboard';
  if (isDispatcher(u)) return '/dispatcher';
  return '/unauthorized';
};