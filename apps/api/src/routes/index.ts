import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tmdbRouter from "./tmdb";
import viewerTypeRouter from "./viewer-type";
import recsRouter from "./recs";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/tmdb", tmdbRouter);
router.use("/viewer-type", viewerTypeRouter);
router.use("/recs", recsRouter);

export default router;
