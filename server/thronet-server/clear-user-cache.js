// clear-user-cache.js
// One-off script to flush the stale "user:*" cache keys that were
// poisoned by the old updateLastLogin() bug (it used to overwrite the
// full-profile cache with a stripped-down { userId, emailVerified } object).
//
// Run this with Railway CLI so it automatically gets the correct
// REDIS_HOST / REDIS_PORT / REDIS_PASSWORD from your Railway project:
//
//   railway run node clear-user-cache.js
//
// (If you don't have Railway CLI yet: npm install -g @railway/cli
//  then: railway login   ->   railway link   (pick this project)
//  then run the command above)

const Redis = require('ioredis');

async function main() {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0'),
    connectTimeout: 10000,
  });

  client.on('error', (err) => {
    console.error('❌ Redis connection error:', err.message);
  });

  try {
    console.log('🔌 Connecting to Redis...', {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    });

    await client.ping();
    console.log('✅ Connected to Redis');

    let cursor = '0';
    let deletedCount = 0;
    const matchedKeys = [];

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        'MATCH',
        'authuser:*',
        'COUNT',
        100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        matchedKeys.push(...keys);
      }
    } while (cursor !== '0');

    console.log(`🔍 Found ${matchedKeys.length} keys matching "user:*"`);

    if (matchedKeys.length > 0) {
      // Delete in batches of 500 to avoid one huge command
      const batchSize = 500;
      for (let i = 0; i < matchedKeys.length; i += batchSize) {
        const batch = matchedKeys.slice(i, i + batchSize);
        const result = await client.del(...batch);
        deletedCount += result;
      }
    }

    console.log(`🗑️  Deleted ${deletedCount} keys`);
    console.log('✅ Cache flush complete');
  } catch (err) {
    console.error('❌ Failed to flush cache:', err.message);
    process.exitCode = 1;
  } finally {
    await client.quit();
  }
}

main();