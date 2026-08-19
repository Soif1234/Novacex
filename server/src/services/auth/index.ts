/**
 * Auth Service Skeleton
 * Authoritative user authentication and session management.
 * Implementation to be completed in Phase 4 Step 4.
 */

export interface IAuthService {
  signup(email: string, passwordHash: string): Promise<{ userId: string }>;
  login(email: string, passwordHash: string): Promise<{ sessionToken: string; userId: string }>;
  validateSession(sessionToken: string): Promise<{ valid: boolean; userId?: string }>;
  revokeSession(sessionToken: string): Promise<void>;
}

export const authServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_4'
};
