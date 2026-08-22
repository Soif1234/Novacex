import { Router } from 'express';
import { AuthController } from '../controllers/auth.controller';
import { requireAuth, authRateLimiter } from '../middleware/auth';

const router = Router();

// Public Authentication endpoints (rate limited)
router.post('/signup', authRateLimiter(20, 60000), AuthController.signup);
router.post('/login', authRateLimiter(20, 60000), AuthController.login);
router.post('/2fa/verify-login', authRateLimiter(20, 60000), AuthController.verify2FALogin);
router.post('/logout', AuthController.logout);

// Protected Authentication endpoints
router.get('/me', requireAuth, AuthController.getMe);

// Two-Factor Authentication (2FA) endpoints
router.post('/2fa/setup', requireAuth, AuthController.setup2FA);
router.post('/2fa/enable', requireAuth, AuthController.enable2FA);
router.post('/2fa/disable', requireAuth, AuthController.disable2FA);

// API Key Management endpoints
router.post('/api-keys', requireAuth, AuthController.createApiKey);
router.get('/api-keys', requireAuth, AuthController.listApiKeys);
router.delete('/api-keys/:id', requireAuth, AuthController.revokeApiKey);
router.post('/api-keys/:id/revoke', requireAuth, AuthController.revokeApiKey);

export const authRoutes = router;
