import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { CircuitBreakerController } from '../controllers/circuit-breaker.controller';
import { ReconciliationController } from '../controllers/reconciliation.controller';
import { requireAuth, requireRole, require2FA } from '../middleware/auth';
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
import { mutationRateLimiter } from '../middleware/rateLimit';
// Treasury Operations (Phase 10.6)
import { TreasuryController } from '../controllers/treasury.controller';

const router = Router();

/**
 * Dedicated Admin & Security Audit Routes (/api/v1/admin/*)
 * All endpoints strictly require authenticated ADMIN role.
 */
router.use(requireAuth);
router.use(requireRole('ADMIN'));

router.get('/users', AdminController.listUsers);
router.get('/users/:userId', AdminController.getUserDetail);
router.patch('/users/:userId/status', AdminController.updateUserStatus);
router.patch('/users/:userId/role', AdminController.updateUserRole);
router.get('/audit-logs', AdminController.getAuditLogs);

// Circuit Breaker Operational Controls
router.get('/circuit-breaker/status', CircuitBreakerController.getAdminStatus);
router.post('/circuit-breaker/halt', CircuitBreakerController.halt);
router.post('/circuit-breaker/resume', CircuitBreakerController.resume);

// Balance Reconciliation & Security Threat Alerting
router.post('/reconciliation/run', ReconciliationController.triggerReconciliation);
router.get('/reconciliation/reports', ReconciliationController.getReports);
router.get('/reconciliation/alerts', ReconciliationController.getAlerts);
router.post('/reconciliation/alerts/:alertId/resolve', ReconciliationController.resolveAlert);

// Operational Metrics & System Telemetry (Phase 8.4.1)
router.get('/metrics', AdminController.getMetrics);
router.get('/metrics/prometheus', AdminController.getPrometheusMetrics);

// Withdrawal Approval (Phase 9.7)
router.get('/withdrawals/pending', AdminController.getPendingWithdrawals);
router.post(
  '/withdrawals/:id/approve',
  requireCircuitBreaker('WITHDRAWALS'),
  require2FA,
  mutationRateLimiter(),
  AdminController.approveWithdrawal
);
router.post(
  '/withdrawals/:id/reject',
  requireCircuitBreaker('WITHDRAWALS'),
  require2FA,
  mutationRateLimiter(),
  AdminController.rejectWithdrawal
);
router.post(
  '/withdrawals/:id/resolve',
  requireCircuitBreaker('WITHDRAWALS'),
  require2FA,
  mutationRateLimiter(),
  AdminController.resolveWithdrawal
);

router.post(
  '/withdrawals/:id/speedup',
  requireCircuitBreaker('WITHDRAWALS'),
  require2FA,
  mutationRateLimiter(),
  AdminController.speedUpWithdrawal
);
router.post(
  '/withdrawals/:id/cancel',
  requireCircuitBreaker('WITHDRAWALS'),
  require2FA,
  mutationRateLimiter(),
  AdminController.cancelWithdrawal
);

// Treasury Operations (Phase 10.6) — Safe consolidation, ADMIN + 2FA only.
// Destination is NEVER admin input: TreasuryManager resolves the trusted Safe
// anchor from immutable env configuration and verifies it on-chain.
router.post(
  '/treasury/consolidate',
  require2FA,
  mutationRateLimiter(),
  TreasuryController.consolidateToSafe
);

export const adminRoutes = router;

