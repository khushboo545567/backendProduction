import { param, body, query } from 'express-validator';
import { Domain } from '@/shared/constants/domains';
import { ExperienceLevel, MentorStatus } from '../interface/mentor.types';

class MentorValidator {
  /**
   * ✅ FIXED: Validate UUID v4 format (not ObjectId)
   */
  private static isValidUUID(value: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(value);
  }

  /**
   * Validate URL format with strict https and domain checks.
   * Empty string/null/undefined is allowed when optional.
   */
  public static validateUrl(value: unknown, allowedDomains?: string[]): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') throw new Error('URL must be a string');
    const trimmed = value.trim();
    if (trimmed === '') return true;
    if (trimmed.length > 200) throw new Error('URL cannot exceed 200 characters');

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('Invalid URL format');
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('URL must use https:// protocol');
    }

    if (allowedDomains && allowedDomains.length > 0) {
      const host = parsed.hostname.toLowerCase();
      const isAllowed = allowedDomains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`)
      );
      if (!isAllowed) {
        throw new Error(`URL must be from ${allowedDomains.join(' or ')}`);
      }
    }

    return true;
  }

  /**
   * Validate previousRoles array
   */
  public static validatePreviousRoles(roles: unknown): boolean {
    if (roles === undefined || roles === null) return true;
    if (!Array.isArray(roles)) throw new Error('Experience entries must be an array');
    if (roles.length > 10) throw new Error('Cannot exceed 10 experience entries');

    const employmentTypes = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Freelance'];
    const yyyyMmRegex = /^\d{4}-(?:0[1-9]|1[0-2])$/;

    for (let i = 0; i < roles.length; i++) {
      const role = roles[i];
      if (!role || typeof role !== 'object') {
        throw new Error(`Experience entry #${i + 1} must be an object`);
      }
      if (!role.title || typeof role.title !== 'string' || !role.title.trim()) {
        throw new Error(`Title is required for experience entry #${i + 1}`);
      }
      if (role.title.trim().length > 100) {
        throw new Error(`Title for experience entry #${i + 1} cannot exceed 100 characters`);
      }
      if (!role.company || typeof role.company !== 'string' || !role.company.trim()) {
        throw new Error(`Company is required for experience entry #${i + 1}`);
      }
      if (role.company.trim().length > 100) {
        throw new Error(`Company for experience entry #${i + 1} cannot exceed 100 characters`);
      }
      if (role.startDate !== undefined && role.startDate !== null && role.startDate !== '') {
        if (!yyyyMmRegex.test(role.startDate)) {
          throw new Error(`Start date for experience entry #${i + 1} must be in YYYY-MM format`);
        }
      }
      const isCurrent = Boolean(role.isCurrent);
      if (!isCurrent && role.endDate !== undefined && role.endDate !== null && role.endDate !== '') {
        if (!yyyyMmRegex.test(role.endDate)) {
          throw new Error(`End date for experience entry #${i + 1} must be in YYYY-MM format`);
        }
        if (role.startDate && yyyyMmRegex.test(role.startDate)) {
          if (role.endDate < role.startDate) {
            throw new Error(`End date cannot be earlier than start date for experience entry #${i + 1}`);
          }
        }
      }
      if (role.employmentType !== undefined && role.employmentType !== null && role.employmentType !== '') {
        if (!employmentTypes.includes(role.employmentType)) {
          throw new Error(`Invalid employment type for experience entry #${i + 1}. Must be one of: ${employmentTypes.join(', ')}`);
        }
      }
      if (role.description !== undefined && role.description !== null && role.description !== '') {
        if (typeof role.description === 'string' && role.description.length > 300) {
          throw new Error(`Description for experience entry #${i + 1} cannot exceed 300 characters`);
        }
      }
      if (role.companyLogo !== undefined && role.companyLogo !== null && role.companyLogo !== '') {
        try {
          MentorValidator.validateUrl(role.companyLogo);
        } catch {
          throw new Error(`Company logo for experience entry #${i + 1} must be a valid https URL`);
        }
      }
    }
    return true;
  }

  /**
   * ✅ UPDATED: Validate mentorId (UUID v4)
   */
  static getMentorById() {
    return [
      param('id')
        .trim()
        .notEmpty()
        .withMessage('Mentor ID is required')
        .custom((value) => {
          if (!this.isValidUUID(value)) {
            throw new Error('Invalid mentor ID format');
          }
          return true;
        }),
    ];
  }

  /**
   * ✅ UPDATED: Validate userId (UUID v4)
   */
  static getMentorByUserId() {
    return [
      param('userId')
        .trim()
        .notEmpty()
        .withMessage('User ID is required')
        .custom((value) => {
          if (!this.isValidUUID(value)) {
            throw new Error('Invalid user ID format');
          }
          return true;
        }),
    ];
  }

  /**
   * ✅ Create mentor validation
   */
  static createMentor() {
    return [
      // body('userId')
      //   .trim()
      //   .notEmpty()
      //   .withMessage('User ID is required')
      //   .custom((value) => {
      //     if (!this.isValidUUID(value)) {
      //       throw new Error('Invalid user ID format');
      //     }
      //     return true;
      //   }),
      
      body('companyId')
        .optional()
        .trim()
        .custom((value) => {
          if (value && !this.isValidUUID(value)) {
            throw new Error('Invalid company ID format');
          }
          return true;
        }),

      body('company')
        .trim()
        .notEmpty()
        .withMessage('Company is required')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Company must contain letters or digits');
          }
          return true;
        }),

      body('college')
        .trim()
        .notEmpty()
        .withMessage('College is required')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('College must contain letters or digits');
          }
          return true;
        }),

      body('degree')
        .trim()
        .notEmpty()
        .withMessage('Degree is required')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Degree must contain letters or digits');
          }
          return true;
        }),

      body('branch')
        .trim()
        .notEmpty()
        .withMessage('Branch is required')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Branch must contain letters or digits');
          }
          return true;
        }),
      
      body('title')
        .trim()
        .notEmpty()
        .withMessage('Title is required')
        .isLength({ min: 5, max: 100 })
        .withMessage('Title must be 5-100 characters'),
      
      body('bio')
        .trim()
        .notEmpty()
        .withMessage('Bio is required')
        .isLength({ min: 50, max: 2000 })
        .withMessage('Bio must be 50-2000 characters'),
      
      body('tagline')
        .optional()
        .trim()
        .isLength({ max: 150 })
        .withMessage('Tagline cannot exceed 150 characters'),
      
      body('domains')
        .isArray({ min: 1, max: 5 })
        .withMessage('Must provide 1-5 domains')
        .custom((domains: string[]) => {
          const validDomains = Object.values(Domain);
          const allValid = domains.every(d => validDomains.includes(d as Domain));
          if (!allValid) {
            throw new Error('Invalid domain(s)');
          }
          return true;
        }),
      
      body('skills')
        .isArray({ min: 1, max: 20 })
        .withMessage('Must provide 1-20 skills'),
      
      // CHANGE: languages optional
body('languages')
  .optional()  // ADD .optional()
  .isArray({ min: 1 })
  .withMessage('At least one language is required'),

      body('experience.total').toInt()
        .isInt({ min: 0, max: 50 })
        .withMessage('Experience must be 0-50 years'),
      
     // CHANGE: experience.level optional (backend set karega)
body('experience.level')
  .optional()  // ADD .optional()
  .isIn(Object.values(ExperienceLevel))
  .withMessage('Invalid experience level'),

      body('experience.currentRole')
        .trim()
        .notEmpty()
        .withMessage('Current role is required'),
      
      body('pricing.quickCall').optional()
        .isInt({ min: 0 })
        .withMessage('Quick call price must be >= 0'),
      
      body('pricing.deepDive').optional()
        .isInt({ min: 0 })
        .withMessage('Deep dive price must be >= 0'),
      
      body('pricing.resumeReview').optional()
        .isInt({ min: 0 })
        .withMessage('Resume review price must be >= 0'),
      
      body('pricing.mockInterview').optional()
        .isInt({ min: 0 })
        .withMessage('Mock interview price must be >= 0'),
      
      body('pricing.careerPlanning').optional()
        .isInt({ min: 0 })
        .withMessage('Career planning price must be >= 0'),
      
      body('pricing.portfolioReview').optional()
        .isInt({ min: 0 })
        .withMessage('Portfolio review price must be >= 0'),
      
      body('pricing.askQuery').optional()
        .isInt({ min: 0 })
        .withMessage('Ask query price must be >= 0'),
      
      body('pricing.groupSession').optional()
        .isInt({ min: 0 })
        .withMessage('Group session price must be >= 0'),
      
      body('availability.timezone').optional()
        .trim()
        .notEmpty()
        .withMessage('Timezone is required'),
      
      body('availability.daysAvailable').optional()
        .isArray({ min: 1 })
        .withMessage('At least one available day is required'),
      
      body('availability.autoAcceptBookings').optional()
        .isBoolean()
        .withMessage('Auto accept bookings must be boolean'),
      
      body('availability.maxSessionsPerDay').optional()
        .isInt({ min: 1, max: 15 })
        .withMessage('Max sessions per day must be 1-15'),
      
      body('availability.bufferBetweenSessions').optional()
        .isInt({ min: 0 })
        .withMessage('Buffer must be >= 0'),

      body('experience.previousRoles')
        .optional()
        .custom((roles) => MentorValidator.validatePreviousRoles(roles)),

      body('socialProof.linkedinUrl')
        .optional({ nullable: false })
        .custom((val) => {
          if (val === '' || val === null || (typeof val === 'string' && val.trim() === '')) {
            throw new Error('LinkedIn URL cannot be cleared or empty');
          }
          return MentorValidator.validateUrl(val, ['linkedin.com']);
        }),

      body('socialProof.githubUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['github.com'])),

      body('socialProof.twitterUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['x.com', 'twitter.com'])),

      body('socialProof.leetcodeUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['leetcode.com'])),

      body('socialProof.portfolioUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val)),

      body('socialProof.websiteUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val)),
    ];
  }

  /**
   * ✅ UPDATED: Update mentor validation
   */
  static updateMentor() {
    return [
      param('id')
        .trim()
        .notEmpty()
        .withMessage('Mentor ID is required')
        .custom((value) => {
          if (!this.isValidUUID(value)) {
            throw new Error('Invalid mentor ID format');
          }
          return true;
        }),
      
      body('title')
        .optional()
        .trim()
        .isLength({ min: 5, max: 100 })
        .withMessage('Title must be 5-100 characters'),
      
      body('bio')
        .optional()
        .trim()
        .isLength({ min: 50, max: 2000 })
        .withMessage('Bio must be 50-2000 characters'),
      
      body('tagline')
        .optional()
        .trim()
        .isLength({ max: 150 })
        .withMessage('Tagline cannot exceed 150 characters'),
      
      body('domains')
        .optional()
        .isArray({ min: 1, max: 5 })
        .withMessage('Must provide 1-5 domains'),
      
      body('skills')
        .optional()
        .isArray({ min: 1, max: 20 })
        .withMessage('Must provide 1-20 skills'),
      
      body('languages')
        .optional()
        .isArray({ min: 1 })
        .withMessage('At least one language is required'),
      
      body('status')
        .optional()
        .isIn(Object.values(MentorStatus))
        .withMessage('Invalid status'),

      body('company')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Company cannot be empty')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Company must contain letters or digits');
          }
          return true;
        }),

      body('college')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('College cannot be empty')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('College must contain letters or digits');
          }
          return true;
        }),

      body('degree')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Degree cannot be empty')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Degree must contain letters or digits');
          }
          return true;
        }),

      body('branch')
        .optional()
        .trim()
        .notEmpty()
        .withMessage('Branch cannot be empty')
        .custom((value) => {
          if (!/[a-zA-Z0-9]/.test(value)) {
            throw new Error('Branch must contain letters or digits');
          }
          return true;
        }),

      body('experience.previousRoles')
        .optional()
        .custom((roles) => MentorValidator.validatePreviousRoles(roles)),

      body('socialProof.linkedinUrl')
        .optional({ nullable: false })
        .custom((val) => {
          if (val === '' || val === null || (typeof val === 'string' && val.trim() === '')) {
            throw new Error('LinkedIn URL cannot be cleared or empty');
          }
          return MentorValidator.validateUrl(val, ['linkedin.com']);
        }),

      body('socialProof.githubUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['github.com'])),

      body('socialProof.twitterUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['x.com', 'twitter.com'])),

      body('socialProof.leetcodeUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val, ['leetcode.com'])),

      body('socialProof.portfolioUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val)),

      body('socialProof.websiteUrl')
        .optional()
        .custom((val) => MentorValidator.validateUrl(val)),
    ];
  }

  /**
   * ✅ UPDATED: Delete mentor validation
   */
  static deleteMentor() {
    return [
      param('id')
        .trim()
        .notEmpty()
        .withMessage('Mentor ID is required')
        .custom((value) => {
          if (!this.isValidUUID(value)) {
            throw new Error('Invalid mentor ID format');
          }
          return true;
        }),
    ];
  }

  /**
   * ✅ UPDATED: Get mentor stats validation
   */
  static getMentorStats() {
    return [
      param('id')
        .trim()
        .notEmpty()
        .withMessage('Mentor ID is required')
        .custom((value) => {
          if (!this.isValidUUID(value)) {
            throw new Error('Invalid mentor ID format');
          }
          return true;
        }),
    ];
  }

  /**
   * ✅ Get pagination validation
   */
  static getPagination() {
    return [
      query('page')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Page must be >= 1')
        .toInt(),
      
      query('limit')
        .optional()
        .isInt({ min: 1, max: 100 })
        .withMessage('Limit must be 1-100')
        .toInt(),
      
      query('sortBy')
        .optional()
        .isIn(['rating', 'experience', 'price', 'sessions', 'createdAt'])
        .withMessage('Invalid sort field'),
      
      query('sortOrder')
        .optional()
        .isIn(['asc', 'desc'])
        .withMessage('Sort order must be asc or desc'),
      
      query('domains')
        .optional()
        .custom((value) => {
          const domains = Array.isArray(value) ? value : [value];
          const validDomains = Object.values(Domain);
          const allValid = domains.every(d => validDomains.includes(d as Domain));
          if (!allValid) {
            throw new Error('Invalid domain(s)');
          }
          return true;
        }),
      
      query('minRating')
        .optional()
        .isFloat({ min: 0, max: 5 })
        .withMessage('Min rating must be 0-5')
        .toFloat(),
      
      query('minExperience')
        .optional()
        .isInt({ min: 0 })
        .withMessage('Min experience must be >= 0')
        .toInt(),
      
      query('featured')
        .optional()
        .isBoolean()
        .withMessage('Featured must be boolean')
        .toBoolean(),
    ];
  }
}

export default MentorValidator;















