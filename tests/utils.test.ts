import { describe, it, expect } from 'vitest';
import { defaultBackoff, validatePayload } from '../src/utils.js';

describe('defaultBackoff', () => {
  it('should return exponential backoff values', () => {
    expect(defaultBackoff(0)).toBe(1000);    // 1 second
    expect(defaultBackoff(1)).toBe(2000);    // 2 seconds
    expect(defaultBackoff(2)).toBe(4000);    // 4 seconds
    expect(defaultBackoff(3)).toBe(8000);    // 8 seconds
    expect(defaultBackoff(4)).toBe(16000);   // 16 seconds
  });
});

describe('validatePayload', () => {
  it('should return JSON string for valid payloads', () => {
    expect(validatePayload({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(validatePayload([1, 2, 3])).toBe('[1,2,3]');
    expect(validatePayload('hello')).toBe('"hello"');
    expect(validatePayload(123)).toBe('123');
    expect(validatePayload(null)).toBe('null');
    expect(validatePayload(true)).toBe('true');
  });

  it('should throw for circular references', () => {
    const circular: any = { foo: 'bar' };
    circular.self = circular;
    
    expect(() => validatePayload(circular)).toThrow('Payload is not JSON-serializable');
  });

  it('should throw for BigInt', () => {
    expect(() => validatePayload(BigInt(123))).toThrow('Payload is not JSON-serializable');
  });

  it('should handle nested objects', () => {
    const payload = {
      user: {
        name: 'John',
        email: 'john@example.com',
      },
      items: [1, 2, 3],
    };
    
    expect(validatePayload(payload)).toBe(JSON.stringify(payload));
  });
});
