import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { requireAuth, authRateLimiter } from '../middleware/auth';

const router = Router();

// Public Authentication endpoints (rate limited)
router.post('/signup', authRateLimiter(20, 60000), AuthController.signup);
router.post('/login', authRateLimiter(20, 60000), AuthController.login);
router.post('/logout', AuthController.logout);

// Protected Authentication endpoints
router.get('/me', requireAuth, AuthController.getMe);

export const authRoutes = router;
