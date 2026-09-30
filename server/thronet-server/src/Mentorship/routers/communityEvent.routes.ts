//Mentorship>routers>communityEvent.routes.ts

import { Router } from 'express';
import communityEventController from '@/Mentorship/controllers/communityEvent.controller';
import AuthMiddleware from '@/shared/middlewares/auth.middleware';
import { uploadSingle } from '@/shared/upload/upload';

const router = Router();

router.get('/', communityEventController.listEvents);
router.post('/', AuthMiddleware.authenticate, uploadSingle('image', 'image', false), communityEventController.createEvent);
router.get('/:id', communityEventController.getEvent);
router.put('/:id', AuthMiddleware.authenticate, uploadSingle('image', 'image', false), communityEventController.updateEvent);
router.patch('/:id/cancel', AuthMiddleware.authenticate, communityEventController.cancelEvent);
router.delete('/:id', AuthMiddleware.authenticate, communityEventController.deleteEvent);

router.post('/:id/rsvp', AuthMiddleware.authenticate, communityEventController.rsvp);
router.delete('/:id/rsvp', AuthMiddleware.authenticate, communityEventController.cancelRsvp);
router.get('/:id/attendees', communityEventController.listAttendees);

export default router;