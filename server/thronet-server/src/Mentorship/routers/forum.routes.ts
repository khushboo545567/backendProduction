//Mentorship>routers>forum.routes.ts

import { Router } from "express";
import forumController from "../controllers/forum.controller";
import AuthMiddleware from "../../shared/middlewares/auth.middleware";

const router = Router();

router.get("/", AuthMiddleware.authenticateOptional as any, forumController.listForums);
router.post("/", AuthMiddleware.authenticate, forumController.createForum);
router.get("/:id", AuthMiddleware.authenticateOptional as any, forumController.getForum);
router.delete("/:id", AuthMiddleware.authenticate, forumController.deleteForum);
router.patch("/:id", AuthMiddleware.authenticate, forumController.updateForum);
router.patch("/:id/pin", AuthMiddleware.authenticate, forumController.pinForum);
router.patch("/:id/lock", AuthMiddleware.authenticate, forumController.lockForum);
router.post("/:id/upvote", AuthMiddleware.authenticate, forumController.toggleUpvote);

router.get("/:id/replies", AuthMiddleware.authenticateOptional as any, forumController.listReplies);
router.post("/:id/replies", AuthMiddleware.authenticate, forumController.addReply);

export default router;