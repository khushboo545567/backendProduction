import { z } from 'zod';

export const createCommunityEventSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(2000).optional(),
  date: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'date must be a valid ISO date string',
  }),
  type: z.enum(['meetup', 'webinar', 'workshop', 'networking']),
  resourceLink: z.string().url().optional(),
  capacity: z.number().int().positive().optional(),
});

export const updateCommunityEventSchema = createCommunityEventSchema.partial();

export const communityEventListQuerySchema = z.object({
  type: z.string().optional(),
  upcoming: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
});