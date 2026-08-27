import { Router } from 'express';
import { AdminController } from '../controllers/admin.controller';
import { CircuitBreakerController } from '../controllers/circuit-breaker.controller';
import { ReconciliationController } from '../controllers/reconciliation.controller';
import { requireAuth, requireRole } from '../middleware/auth';

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
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
router.get('/withdrawals/pending', AdminController.getPendingWithdrawals);
router.post('/withdrawals/:id/approve', requireCircuitBreaker('WITHDRAWALS'), AdminController.approveWithdrawal);
router.post('/withdrawals/:id/reject', requireCircuitBreaker('WITHDRAWALS'), AdminController.rejectWithdrawal);

export const adminRoutes = router;

