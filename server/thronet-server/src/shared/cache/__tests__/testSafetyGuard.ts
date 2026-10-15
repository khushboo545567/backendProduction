/**
 * testSafetyGuard.ts
 * Enforces strict environment safety for test suites.
 * Refuses execution unless:
 * 1. MongoDB database name contains "test" (NEVER redirects silently).
 * 2. Redis URL / host points to a local or test instance.
 */

export function assertTestEnvironmentSafety(): string {
  // 1. MongoDB verification
  const rawMongoUri = process.env['MONGODB_TEST_URI'] || process.env['MONGODB_URI'];
  if (!rawMongoUri) {
    throw new Error('TEST SAFETY CHECK FAILED: Neither MONGODB_TEST_URI nor MONGODB_URI is defined.');
  }

  const parsedMongo = new URL(rawMongoUri);
  const dbName = parsedMongo.pathname.replace(/^\//, '');

  if (!dbName.toLowerCase().includes('test')) {
    throw new Error(
      `TEST SAFETY CHECK FAILED: MongoDB database name "${dbName}" does not contain "test". Refusing to run tests against non-test database! Set MONGODB_TEST_URI=mongodb://127.0.0.1:27017/thronet_test`
    );
  }

  // 2. Redis verification
  const rawRedisHost = process.env['REDIS_TEST_HOST'] || process.env['REDIS_HOST'] || '127.0.0.1';
  const redisUrl = process.env['REDIS_TEST_URL'] || process.env['REDIS_URL'] || process.env['REDIS_QUEUE_URL'];

  const isLocalOrTestHost = (host: string): boolean => {
    const h = host.toLowerCase().trim();
    return (
      h === '127.0.0.1' ||
      h === 'localhost' ||
      h.includes('test') ||
      h.includes('local')
    );
  };

  if (!isLocalOrTestHost(rawRedisHost)) {
    throw new Error(
      `TEST SAFETY CHECK FAILED: Redis host "${rawRedisHost}" is not a local/test instance (must be 127.0.0.1, localhost, or contain test/local). Refusing to run tests against remote/non-test Redis!`
    );
  }

  // Ensure process.env.REDIS_HOST points to the verified test host for connection factories
  process.env['REDIS_HOST'] = rawRedisHost;

  if (redisUrl) {
    try {
      const parsedRedis = new URL(redisUrl);
      if (!isLocalOrTestHost(parsedRedis.hostname)) {
        throw new Error(
          `TEST SAFETY CHECK FAILED: Redis URL host "${parsedRedis.hostname}" is not a local/test instance.`
        );
      }
    } catch (err: any) {
      if (!isLocalOrTestHost(redisUrl)) {
        throw new Error(
          `TEST SAFETY CHECK FAILED: Redis URL "${redisUrl}" is not a local/test instance.`
        );
      }
    }
  }

  console.log(`🛡️ [Safety Guard Verified] Target DB: "${dbName}" (test DB) | Redis: Local/Test instance Verified`);
  return rawMongoUri;
}
