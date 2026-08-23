import { Router } from 'express';
import { HealthController } from '../controllers/health.controller';
import { CircuitBreakerController } from '../controllers/circuit-breaker.controller';

const router = Router();

// Liveness Probes
router.get('/health/live', HealthController.getLiveness);
router.get('/live', HealthController.getLiveness);

// Readiness Probes
router.get('/health/ready', HealthController.getReadiness);
router.get('/ready', HealthController.getReadiness);

// System Health Endpoints
router.get('/health', HealthController.getHealth);
router.get('/health/detailed', HealthController.getDetailedHealth);

// Circuit Breaker Public Status
router.get('/circuit-breaker/status', CircuitBreakerController.getPublicStatus);

export const healthRoutes = router;
