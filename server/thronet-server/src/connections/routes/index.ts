// /**
//  * Centralized Route Management
//  * @module routes/connections/index
//  * @version 1.0.0
//  */

// import { Router, Request, Response } from 'express';

// const router = Router();
// console.log('🔍 ConnectionRoutes mounted successfully in routes/connections/index.ts');

// import { connectionRouter } from './connection.routes';
// import { requestRouter } from './request.routes';
// import { followRouter } from './follow.routes';
// import mutualRouter from './mutual.routes';
// import searchRoutes from './search.routes';
// import blockRouter from './block.routes';
// import catchupRoutes from './catchup.routes';
// import profileviewsRoutes from './profileviews.routes';
// import ProfileViewDigestCron from '@/jobs/profileViewDigestCron';
// import BirthdayAnniversaryCron from '@/jobs/birthdayAnniversaryCron';

// router.use('/catchup', catchupRoutes);
// router.use('/connection', connectionRouter);
// router.use('/requests', requestRouter);
// router.use('/follow', followRouter);
// router.use('/mutual', mutualRouter);
// // router.use('/search', searchRoutes);
// router.use('/block', blockRouter);
// router.use('/profile-views', profileviewsRoutes);

// // Start the profile-view digest cron (was written but never initialized anywhere)
// ProfileViewDigestCron.init();

// // Start the birthday / work-anniversary cron
// BirthdayAnniversaryCron.init();

// export default router;
// console.log('🔍 ConnectionRoutes loaded successfully in routes/connections/index.ts');


console.log('🔍 [1] connection.routes loading...');
import { connectionRouter } from './connection.routes';
console.log('🔍 [2] connection.routes loaded');

console.log('🔍 [3] request.routes loading...');
import { requestRouter } from './request.routes';
console.log('🔍 [4] request.routes loaded');

console.log('🔍 [5] follow.routes loading...');
import { followRouter } from './follow.routes';
console.log('🔍 [6] follow.routes loaded');

console.log('🔍 [7] mutual.routes loading...');
import mutualRouter from './mutual.routes';
console.log('🔍 [8] mutual.routes loaded');

console.log('🔍 [9] search.routes loading...');
import searchRoutes from './search.routes';
console.log('🔍 [10] search.routes loaded');

console.log('🔍 [11] block.routes loading...');
import blockRouter from './block.routes';
console.log('🔍 [12] block.routes loaded');

console.log('🔍 [13] catchup.routes loading...');
import catchupRoutes from './catchup.routes';
console.log('🔍 [14] catchup.routes loaded');

console.log('🔍 [15] profileviews.routes loading...');
import profileviewsRoutes from './profileviews.routes';
console.log('🔍 [16] profileviews.routes loaded');