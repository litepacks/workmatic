import { describe, it, expect } from 'vitest';
import { parseCSVLine, escapeCSV } from '../src/cli/handlers.js';

describe('parseCSVLine branches', () => {
  const cases: [string, string[]][] = [
    ['', ['']],
    ['x', ['x']],
    ['a,b', ['a', 'b']],
    ['"x,y",z', ['x,y', 'z']],
    ['"a""b"', ['a"b']],
    ['"open', ['open']],
  ];

  it.each(cases)('parses %j', (line, expected) => {
    expect(parseCSVLine(line)).toEqual(expected);
  });

  it('escapeCSV quotes double quotes', () => {
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
  });
});
