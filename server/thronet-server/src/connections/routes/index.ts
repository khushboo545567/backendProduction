import { Router } from 'express';
import { connectionRouter } from './connection.routes';
import { requestRouter } from './request.routes';
import { followRouter } from './follow.routes';
import mutualRouter from './mutual.routes';
import searchRoutes from './search.routes';
import blockRouter from './block.routes';
import catchupRoutes from './catchup.routes';
import profileviewsRoutes from './profileviews.routes';
import networkRoutes from './network.routes';
import suggestionsRoutes from './suggestions.routes';
import ProfileViewDigestCron from '@/jobs/profileViewDigestCron';
import BirthdayAnniversaryCron from '@/jobs/birthdayAnniversaryCron';
import PymkSuggestionCron from '@/jobs/pymkSuggestionCron';

const router = Router();

// Mount all sub-routes synchronously
router.use('/catchup', catchupRoutes);
router.use('/connection', connectionRouter);
router.use('/requests', requestRouter);
router.use('/follow', followRouter);
router.use('/mutual', mutualRouter);
router.use('/search', searchRoutes);
router.use('/block', blockRouter);
router.use('/profile-views', profileviewsRoutes);
router.use('/network', networkRoutes);
router.use('/suggestions', suggestionsRoutes);
router.post('/test/birthday-notifications', async (_req, res) => {
  try {
    await BirthdayAnniversaryCron.triggerManually();

    res.json({
      status: 'success',
      message: 'Birthday notification cron triggered successfully',
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Birthday cron failed',
    });
  }
});

// Initialize background crons
ProfileViewDigestCron.init();
BirthdayAnniversaryCron.init();
PymkSuggestionCron.init();

console.log('🔍 ALL connection sub-routes loaded synchronously ✅');

export default router;