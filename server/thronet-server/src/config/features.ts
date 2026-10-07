/**
 * src/config/features.ts
 * Feature flags — launch ke time sirf core modules chalu rehte hain.
 * Baaki modules Railway env variable se on hote hain (default: off).
 */

const readFlag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());
};

export const FEATURES = {
  // Core: hamesha on
  auth: true,
  profile: true,
  mentorship: true,
  notifications: true,

  // Optional: default off
  connections: readFlag('ENABLE_CONNECTIONS', false),
  company: readFlag('ENABLE_COMPANY', false),
  messaging: readFlag('ENABLE_MESSAGING', false),
  studyGroup: readFlag('ENABLE_STUDY_GROUP', false),
  jobService: readFlag('ENABLE_JOB_SERVICE', false),
} as const;

export type FeatureName = keyof typeof FEATURES;

export const enabledFeatures = (): string[] =>
  Object.entries(FEATURES)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);