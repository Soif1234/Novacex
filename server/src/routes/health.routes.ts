import { Router } from 'express';
import { HealthController } from '../controllers/health.controller';
import { CircuitBreakerController } from '../controllers/circuit-breaker.controller';

const router = Router();

router.get('/health', HealthController.getHealth);
router.get('/ready', HealthController.getReadiness);
router.get('/circuit-breaker/status', CircuitBreakerController.getPublicStatus);

export const healthRoutes = router;
