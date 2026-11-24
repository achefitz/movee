import { Router, type IRouter } from "express";
import { requireAuth } from "../auth/middleware";
import authRouter from "./auth";
import friendsRouter from "./friends";
import healthRouter from "./health";
import onboardingRouter from "./onboarding";
import recsRouter from "./recs";
import tmdbRouter from "./tmdb";
import viewerTypeRouter from "./viewer-type";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
// Everything below needs a signed-in account (the TMDB proxy and Claude calls
// spend our keys, so they're not open to the internet).
router.use("/tmdb", requireAuth, tmdbRouter);
router.use("/viewer-type", requireAuth, viewerTypeRouter);
router.use("/recs", recsRouter);
router.use("/friends", friendsRouter);
router.use("/onboarding", onboardingRouter);

export default router;
