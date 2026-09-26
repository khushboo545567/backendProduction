import { Router } from 'express';
import communityController from '@/Mentorship/controllers/community.controller';

const router = Router();

router.get('/top-mentors', communityController.getTopMentors);
router.get('/stats', communityController.getCommunityStats);

export default router;
//community.routes.ts