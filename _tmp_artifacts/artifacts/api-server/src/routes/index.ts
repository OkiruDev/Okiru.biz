import { Router, type IRouter } from "express";
import healthRouter from "./health";
import advisorRouter from "./advisor";
import converterRouter from "./converter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(advisorRouter);
router.use(converterRouter);

export default router;
