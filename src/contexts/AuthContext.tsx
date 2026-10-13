// src/contexts/AuthContext.tsx
import { createContext } from 'react';
import type { BFPPersonnel, AuthState } from '../types';

export interface AuthContextType extends AuthState {
  login: (credentials: {
    email: string;
    password: string;
  }) => Promise<boolean>;
  logout: () => Promise<void>;
  hasPermission: (requiredRoles: string[]) => boolean;
  logActivity: (
    action: string,
    entityType?: string,
    entityId?: string | null,
    status?: 'success' | 'failure',
    errorMessage?: string | null
  ) => Promise<void>;
  createUser: (
    userData: Partial<BFPPersonnel>,
    password: string
  ) => Promise<boolean>;
  updateUser: (
    userId: string,
    updates: Partial<BFPPersonnel>
  ) => Promise<boolean>;
  resetPassword: (email: string) => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextType | undefined>(
  undefined
);