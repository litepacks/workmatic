import type { BackoffFunction } from './types.js';

/**
 * Default exponential backoff function
 * Returns delay in milliseconds: 1000 * 2^attempts
 * 
 * @param attempts - Number of failed attempts
 * @returns Delay in milliseconds
 * 
 * @example
 * ```ts
 * defaultBackoff(0) // 1000ms (1 second)
 * defaultBackoff(1) // 2000ms (2 seconds)
 * defaultBackoff(2) // 4000ms (4 seconds)
 * defaultBackoff(3) // 8000ms (8 seconds)
 * ```
 */
export const defaultBackoff: BackoffFunction = (attempts: number): number => {
  return 1000 * Math.pow(2, attempts);
};

/**
 * Validate that a payload is JSON-serializable
 * 
 * @param payload - The payload to validate
 * @throws Error if payload cannot be serialized to JSON
 * @returns The JSON string representation
 */
export function validatePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new Error(
      `Payload is not JSON-serializable: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Parse a JSON payload safely
 * 
 * @param json - JSON string to parse
 * @returns Parsed payload
 * @throws Error if JSON is invalid
 */
export function parsePayload<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON payload: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Sleep for a specified duration
 * 
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get current timestamp in milliseconds
 */
export function now(): number {
  return Date.now();
}
