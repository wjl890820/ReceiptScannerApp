// supabase/functions/ocr/_shared/ratelimit.ts
// Rate limiting: minute/day windows

const RATE_LIMIT_PER_MINUTE = parseInt(Deno.env.get('RATE_LIMIT_PER_MINUTE') || '6', 10);
const RATE_LIMIT_PER_DAY = parseInt(Deno.env.get('RATE_LIMIT_PER_DAY') || '60', 10);

/**
 * Generate bucket name for rate limiting
 */
export function getMinuteBucket(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `1m:${year}${month}${day}${hour}${minute}`;
}

export function getDayBucket(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `1d:${year}${month}${day}`;
}

/**
 * Check rate limit and increment counter
 * Returns: { allowed: boolean, count: number, limit: number, window: string, retryAfterMs?: number }
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any -- supabase-js client type inference is incomplete in Deno environment
  supabase: any,
  deviceHash: string
): Promise<{
  allowed: boolean;
  count: number;
  limit: number;
  window: string;
  retryAfterMs?: number;
}> {
  // Check minute limit first
  const minuteBucket = getMinuteBucket();
  const { data: minuteData, error: minuteError } = await supabase.rpc('ocr_ratelimit_incr', {
    p_device_hash: deviceHash,
    p_bucket: minuteBucket,
    p_increment: 1,
  });

  if (minuteError) {
    throw minuteError;
  }

  const minuteCount = minuteData as number;

  if (minuteCount > RATE_LIMIT_PER_MINUTE) {
    // Calculate retry after (seconds until next minute)
    const now = new Date();
    const nextMinute = new Date(now);
    nextMinute.setMinutes(nextMinute.getMinutes() + 1);
    nextMinute.setSeconds(0);
    nextMinute.setMilliseconds(0);
    const retryAfterMs = nextMinute.getTime() - now.getTime();

    return {
      allowed: false,
      count: minuteCount,
      limit: RATE_LIMIT_PER_MINUTE,
      window: '1m',
      retryAfterMs,
    };
  }

  // Check day limit
  const dayBucket = getDayBucket();
  const { data: dayData, error: dayError } = await supabase.rpc('ocr_ratelimit_incr', {
    p_device_hash: deviceHash,
    p_bucket: dayBucket,
    p_increment: 1,
  });

  if (dayError) {
    throw dayError;
  }

  const dayCount = dayData as number;

  if (dayCount > RATE_LIMIT_PER_DAY) {
    // Calculate retry after (seconds until next day)
    const now = new Date();
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0);
    nextDay.setMinutes(0);
    nextDay.setSeconds(0);
    nextDay.setMilliseconds(0);
    const retryAfterMs = nextDay.getTime() - now.getTime();

    return {
      allowed: false,
      count: dayCount,
      limit: RATE_LIMIT_PER_DAY,
      window: '1d',
      retryAfterMs,
    };
  }

  return {
    allowed: true,
    count: Math.max(minuteCount, dayCount),
    limit: Math.min(RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_DAY),
    window: minuteCount > dayCount ? '1m' : '1d',
  };
}
