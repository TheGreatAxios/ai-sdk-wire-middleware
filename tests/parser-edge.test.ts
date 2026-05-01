import { describe, expect, test } from 'bun:test';
import {
  encodeArgs,
  findCallSpans,
  parseCalls,
  parseCsvBody,
  parseShellBody,
  splitCsv,
  splitNameAndBody,
  tokenizeShell,
  ToolReduceParseError,
  coerceValue,
} from '../src/parser.ts';
import type { ToolPlan } from '../src/types.ts';

const weatherPlan: ToolPlan = {
  name: 'getWeather',
  signature: 'getWeather: location, units?',
  encoding: 'shell',
  fields: [
    { name: 'location', required: true, type: 'string' },
    { name: 'units', required: false, type: '"metric"|"imperial"' },
  ],
  inputSchema: {},
};

const sendEmailPlan: ToolPlan = {
  name: 'sendEmail',
  signature: 'sendEmail: to, subject, body, priority?',
  encoding: 'shell',
  fields: [
    { name: 'to', required: true, type: 'string' },
    { name: 'subject', required: true, type: 'string' },
    { name: 'body', required: true, type: 'string' },
    { name: 'priority', required: false, type: '"low"|"normal"|"high"' },
  ],
  inputSchema: {},
};

const calculatePlan: ToolPlan = {
  name: 'calculate',
  signature: 'calculate: expression',
  encoding: 'shell',
  fields: [{ name: 'expression', required: true, type: 'string' }],
  inputSchema: {},
};

const jsonPlan: ToolPlan = {
  name: 'createUser',
  signature: 'createUser: <json>',
  encoding: 'json',
  fields: [],
  inputSchema: {},
};

const csvWeatherPlan: ToolPlan = { ...weatherPlan, encoding: 'csv' };

describe('findCallSpans — edge cases', () => {
  test('no calls returns empty', () => {
    expect(findCallSpans('totally normal text')).toEqual([]);
  });

  test('multiline call body is captured', () => {
    const text = '<call>getWeather\n  location="NYC"\n  units=metric\n</call>';
    const spans = findCallSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.body).toContain('location="NYC"');
    expect(spans[0]!.body).toContain('units=metric');
  });

  test('back-to-back calls with no separator', () => {
    const text = '<call>a x=1</call><call>b y=2</call>';
    const spans = findCallSpans(text);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.body).toBe('a x=1');
    expect(spans[1]!.body).toBe('b y=2');
  });

  test('three calls interleaved with prose', () => {
    const text =
      'first <call>a x=1</call> mid <call>b y=2</call> end <call>c z=3</call>!';
    expect(findCallSpans(text).map(s => s.body)).toEqual(['a x=1', 'b y=2', 'c z=3']);
  });

  test('text containing <call but not closed is ignored', () => {
    expect(findCallSpans('here is <call>foo bar without close')).toEqual([]);
  });

  test('span start/end indices are usable as slice bounds', () => {
    const text = 'pre <call>a x=1</call> post';
    const [span] = findCallSpans(text);
    expect(text.slice(span!.start, span!.end)).toBe('<call>a x=1</call>');
  });
});

describe('splitNameAndBody — edge cases', () => {
  test('leading and trailing whitespace', () => {
    expect(splitNameAndBody('   foo   a=1  ')).toEqual({
      toolName: 'foo',
      argsBody: 'a=1',
    });
  });

  test('underscores and digits in name are preserved', () => {
    expect(splitNameAndBody('get_weather_v2 a=1')).toEqual({
      toolName: 'get_weather_v2',
      argsBody: 'a=1',
    });
  });
});

describe('tokenizeShell — edge cases', () => {
  test('multiple consecutive spaces collapse to delimiter', () => {
    expect(tokenizeShell('a=1    b=2')).toEqual(['a=1', 'b=2']);
  });

  test('tab and newline are also delimiters', () => {
    expect(tokenizeShell('a=1\tb=2\nc=3')).toEqual(['a=1', 'b=2', 'c=3']);
  });

  test('single-quoted values with internal spaces', () => {
    expect(tokenizeShell("msg='hello world'")).toEqual(["msg='hello world'"]);
  });

  test('escaped backslash inside quotes', () => {
    expect(tokenizeShell('p="a\\\\b"')).toEqual(['p="a\\\\b"']);
  });

  test('empty input returns empty list', () => {
    expect(tokenizeShell('')).toEqual([]);
  });

  test('only whitespace returns empty list', () => {
    expect(tokenizeShell('    \t  \n ')).toEqual([]);
  });

  test('quoted value containing equals', () => {
    expect(tokenizeShell('expr="a=b+c"')).toEqual(['expr="a=b+c"']);
  });

  test('newline embedded in quoted value via escape sequence', () => {
    expect(tokenizeShell('msg="line1\\nline2"')).toEqual(['msg="line1\\nline2"']);
  });
});

describe('coerceValue — edge cases', () => {
  test('null literal', () => {
    expect(coerceValue('null', undefined)).toBe(null);
  });

  test('untyped numeric only coerces if it round-trips', () => {
    expect(coerceValue('42', undefined)).toBe(42);
    expect(coerceValue('3.14', undefined)).toBe(3.14);
    expect(coerceValue('-7', undefined)).toBe(-7);
    // Non-numeric keeps string form
    expect(coerceValue('42abc', undefined)).toBe('42abc');
  });

  test('typed string never coerces', () => {
    expect(coerceValue('42', 'string')).toBe('42');
    expect(coerceValue('true', 'string')).toBe('true');
  });

  test('int truncates fractional', () => {
    expect(coerceValue('4.9', 'int')).toBe(4);
  });

  test('quoted unicode is decoded into string', () => {
    expect(coerceValue('"héllo 🌍"', undefined)).toBe('héllo 🌍');
  });

  test('escaped tab/newline/return inside quoted string', () => {
    expect(coerceValue('"a\\tb\\nc\\rd"', undefined)).toBe('a\tb\nc\rd');
  });
});

describe('parseShellBody — edge cases', () => {
  test('empty body returns empty object', () => {
    expect(parseShellBody('', weatherPlan)).toEqual({});
  });

  test('escaped quotes inside string value', () => {
    const out = parseShellBody('body="he said \\"hi\\""', sendEmailPlan);
    expect(out).toEqual({ body: 'he said "hi"' });
  });

  test('special characters in value (commas, parens, math)', () => {
    const out = parseShellBody('expression="(12 + 7) * 3, then squared"', calculatePlan);
    expect(out['expression']).toBe('(12 + 7) * 3, then squared');
  });

  test('keys with underscores and digits', () => {
    const plan: ToolPlan = {
      ...weatherPlan,
      fields: [{ name: 'max_results_2', required: true, type: 'int' }],
    };
    expect(parseShellBody('max_results_2=5', plan)).toEqual({ max_results_2: 5 });
  });

  test('boolean false coerces correctly', () => {
    const plan: ToolPlan = {
      ...weatherPlan,
      fields: [{ name: 'enabled', required: true, type: 'boolean' }],
    };
    expect(parseShellBody('enabled=false', plan)).toEqual({ enabled: false });
  });

  test('throws ToolReduceParseError with toolName when token is malformed', () => {
    let caught: ToolReduceParseError | null = null;
    try {
      parseShellBody('justAToken', weatherPlan);
    } catch (e) {
      caught = e as ToolReduceParseError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.name).toBe('ToolReduceParseError');
    expect(caught!.details.toolName).toBe('getWeather');
  });

  test('very long value is preserved', () => {
    const big = 'x'.repeat(5_000);
    const out = parseShellBody(`body="${big}"`, sendEmailPlan);
    expect((out['body'] as string).length).toBe(5_000);
  });

  test('multiline body parses keys split across lines', () => {
    const out = parseShellBody('location="NYC"\n  units=metric', weatherPlan);
    expect(out).toEqual({ location: 'NYC', units: 'metric' });
  });
});

describe('parseCsvBody — edge cases', () => {
  test('empty body returns empty object', () => {
    expect(parseCsvBody('', csvWeatherPlan)).toEqual({});
  });

  test('positional with quoted comma in value', () => {
    expect(parseCsvBody('"Austin, TX", metric', csvWeatherPlan)).toEqual({
      location: 'Austin, TX',
      units: 'metric',
    });
  });

  test('partial positional fills only declared prefix', () => {
    expect(parseCsvBody('"Austin"', csvWeatherPlan)).toEqual({ location: 'Austin' });
  });
});

describe('splitCsv — edge cases', () => {
  test('escaped quote inside quoted value', () => {
    expect(splitCsv('"he said \\"hi\\"", 1')).toEqual(['"he said \\"hi\\""', ' 1']);
  });

  test('trailing empty cell preserved', () => {
    expect(splitCsv('a,b,')).toEqual(['a', 'b', '']);
  });

  test('single value, no commas', () => {
    expect(splitCsv('only')).toEqual(['only']);
  });
});

describe('encodeArgs — edge cases', () => {
  test('json fallthrough rejects non-object body', () => {
    expect(() => encodeArgs('not an object', jsonPlan)).toThrow(ToolReduceParseError);
  });

  test('json fallthrough rejects malformed JSON', () => {
    expect(() => encodeArgs('{not: valid}', jsonPlan)).toThrow(/Invalid JSON/);
  });

  test('json fallthrough accepts empty body as {}', () => {
    expect(JSON.parse(encodeArgs('', jsonPlan))).toEqual({});
  });

  test('shell with no body returns "{}"', () => {
    expect(JSON.parse(encodeArgs('', weatherPlan))).toEqual({});
  });

  test('json fallthrough preserves nested structure', () => {
    const body = '{"profile":{"name":"alice","age":30},"tags":["a","b"]}';
    const out = encodeArgs(body, jsonPlan);
    expect(JSON.parse(out)).toEqual({
      profile: { name: 'alice', age: 30 },
      tags: ['a', 'b'],
    });
  });
});

describe('parseCalls — edge cases', () => {
  test('multiple calls in one text are returned in order', () => {
    const calls = parseCalls(
      'first <call>getWeather location="A"</call>\nsecond <call>getWeather location="B"</call>',
      [weatherPlan],
    );
    expect(calls.map(c => JSON.parse(c.input))).toEqual([
      { location: 'A' },
      { location: 'B' },
    ]);
  });

  test('error names the unknown tool in message', () => {
    let caught: ToolReduceParseError | null = null;
    try {
      parseCalls('<call>nope x=1</call>', [weatherPlan]);
    } catch (e) {
      caught = e as ToolReduceParseError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('Unknown tool "nope"');
    expect(caught!.message).toContain('getWeather');
  });

  test('empty plan list yields helpful "(none)" hint', () => {
    let caught: ToolReduceParseError | null = null;
    try {
      parseCalls('<call>nope x=1</call>', []);
    } catch (e) {
      caught = e as ToolReduceParseError;
    }
    expect(caught!.message).toContain('(none)');
  });
});
