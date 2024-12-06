export interface RateLimitConfig {
    interval: number;  // Time window in milliseconds
    maxRequests: number;  // Maximum number of requests allowed in the interval
    uniqueTokenPerInterval: number;  // Maximum number of tokens to track
}

interface TokenBucket {
    tokens: number;
    lastRefill: number;
}

export class RateLimitError extends Error {
    code: string;
    
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
        this.code = 'RATE_LIMIT_EXCEEDED';
    }
}

export function rateLimit(config: RateLimitConfig) {
    const tokenBuckets = new Map<string, TokenBucket>();
    
    const cleanup = () => {
        const now = Date.now();
        for (const [token, bucket] of tokenBuckets.entries()) {
            if (now - bucket.lastRefill > config.interval) {
                tokenBuckets.delete(token);
            }
        }
    };

    // Run cleanup every interval
    setInterval(cleanup, config.interval);

    return {
        async check(token: string): Promise<void> {
            const now = Date.now();
            let bucket = tokenBuckets.get(token);

            // Create new bucket if it doesn't exist
            if (!bucket) {
                if (tokenBuckets.size >= config.uniqueTokenPerInterval) {
                    cleanup();
                }
                bucket = {
                    tokens: config.maxRequests,
                    lastRefill: now
                };
                tokenBuckets.set(token, bucket);
            }

            // Refill tokens if interval has passed
            if (now - bucket.lastRefill > config.interval) {
                bucket.tokens = config.maxRequests;
                bucket.lastRefill = now;
            }

            if (bucket.tokens <= 0) {
                throw new RateLimitError('Rate limit exceeded');
            }

            bucket.tokens--;
            return Promise.resolve();
        }
    };
}
