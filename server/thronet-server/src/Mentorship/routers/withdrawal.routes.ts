import { Router } from "express";
import { withdrawalController } from "../controllers/withdrawal.controller";

// Mount this inside your Mentorship router:
// app.use("/api/mentorship/withdrawal", withdrawalRouter);

const withdrawalRouter = Router();

// GET    /api/mentorship/withdrawal/:mentorId          → get all methods
// POST   /api/mentorship/withdrawal/:mentorId          → add new method
// PATCH  /api/mentorship/withdrawal/:mentorId/:methodId/default → set default
// DELETE /api/mentorship/withdrawal/:mentorId/:methodId         → delete

withdrawalRouter.get("/:mentorId", withdrawalController.getMethods.bind(withdrawalController));
withdrawalRouter.post("/:mentorId", withdrawalController.addMethod.bind(withdrawalController));
withdrawalRouter.patch("/:mentorId/:methodId/default", withdrawalController.setDefault.bind(withdrawalController));
withdrawalRouter.delete("/:mentorId/:methodId", withdrawalController.deleteMethod.bind(withdrawalController));

export default withdrawalRouter;