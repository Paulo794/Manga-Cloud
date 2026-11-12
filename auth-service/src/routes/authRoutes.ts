import { Router } from 'express';
import { createAuthHandlers, AuthDbAdapter } from '../controllers/authController';
import { verifyToken } from '../middlewares/authMiddleware';
import { audit } from '../audit/auditClient';

export function createAuthRouter(db?: AuthDbAdapter, emit?: typeof audit) {
  const router = Router(), handlers = createAuthHandlers(db, emit);
  router.post('/register', handlers.register);
  router.post('/login', handlers.login);
  router.post('/forgot-password', handlers.forgotPassword);
  router.post('/reset-password', handlers.resetPassword);
  router.get('/verify', verifyToken, handlers.verify);
  router.get('/admin/usuarios', verifyToken, handlers.listUsers);
  router.patch('/admin/usuarios/:id/papel', verifyToken, handlers.changeRole);
  return router;
}
export default createAuthRouter();
