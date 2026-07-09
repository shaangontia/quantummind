/**
 * Route assembler — mounts all domain routers onto a single Express Router.
 * External import: `import router from './api/routes/index.js'` or via routes.ts barrel.
 */
import { Router } from 'express';
import authRouter      from './auth.routes.js';
import portfolioRouter from './portfolio.routes.js';
import analyticsRouter from './analytics.routes.js';
import marketRouter    from './market.routes.js';
import tarsRouter      from './tars.routes.js';
import adminRouter     from './admin.routes.js';

const router = Router();

router.use('/', authRouter);
router.use('/', portfolioRouter);
router.use('/', analyticsRouter);
router.use('/', marketRouter);
router.use('/', tarsRouter);
router.use('/', adminRouter);

export default router;
