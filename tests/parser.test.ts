import { describe, expect, test } from 'bun:test';
import {
  findCallSpans,
  parseWireBody,
  splitNameAndBody,
  tokenizeWire,
  encodeArgs,
  parseCalls,
} from '../src/parser.ts';
import type { ToolPlan } from '../src/types.ts';

const weatherPlan: ToolPlan = {
  name: 'getWeather',
  signature: 'getWeather: location, units?',
  encoding: 'wire',
  fields: [
    { name: 'location', required: true, type: 'string' },
    { name: 'units', required: false, type: '"metric"|"imperial"' },
  ],
  inputSchema: {},
};

const jsonPlan: ToolPlan = { ...weatherPlan, encoding: 'json', fields: [] };

describe('findCallSpans', () => {
  test('finds single call', () => {
    const text = 'hello <call>foo a=1</call> world';
    const spans = findCallSpans(text);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.body).toBe('foo a=1');
  });
  test('finds multiple calls', () => {
    const spans = findCallSpans('<call>a x=1</call> mid <call>b y=2</call>');
    expect(spans.map(s => s.body)).toEqual(['a x=1', 'b y=2']);
  });
  test('ignores unclosed call', () => {
    expect(findCallSpans('<call>foo')).toEqual([]);
  });
});

describe('splitNameAndBody', () => {
  test('extracts name and args body', () => {
    expect(splitNameAndBody('  getWeather location="NYC" units=metric')).toEqual({
      toolName: 'getWeather',
      argsBody: 'location="NYC" units=metric',
    });
  });
  test('handles no args', () => {
    expect(splitNameAndBody('ping')).toEqual({ toolName: 'ping', argsBody: '' });
  });
});

describe('tokenizeWire', () => {
  test('quotes containing spaces', () => {
    expect(tokenizeWire('a="hello world" b=42')).toEqual(['a="hello world"', 'b=42']);
  });
  test('escaped quote', () => {
    expect(tokenizeWire('msg="he said \\"hi\\""')).toEqual(['msg="he said \\"hi\\""']);
  });
});

describe('parseWireBody', () => {
  test('basic kv', () => {
    expect(parseWireBody('location="New York" units=metric', weatherPlan)).toEqual({
      location: 'New York',
      units: 'metric',
    });
  });
  test('coerces booleans and numbers when type is unspecified', () => {
    const plan: ToolPlan = {
      ...weatherPlan,
      fields: [
        { name: 'enabled', required: true, type: 'boolean' },
        { name: 'count', required: true, type: 'int' },
      ],
    };
    expect(parseWireBody('enabled=true count=42', plan)).toEqual({ enabled: true, count: 42 });
  });
  test('keeps unquoted strings as strings when type is string', () => {
    const plan: ToolPlan = {
      ...weatherPlan,
      fields: [{ name: 'location', required: true, type: 'string' }],
    };
    expect(parseWireBody('location=austin', plan)).toEqual({ location: 'austin' });
  });
  test('throws when missing =', () => {
    expect(() => parseWireBody('badtoken', weatherPlan)).toThrow();
  });
});

describe('encodeArgs', () => {
  test('wire → JSON-stringified', () => {
    const json = encodeArgs('location="NYC" units=metric', weatherPlan);
    expect(JSON.parse(json)).toEqual({ location: 'NYC', units: 'metric' });
  });
  test('json fallthrough', () => {
    const json = encodeArgs('{"location":"NYC","units":"metric"}', jsonPlan);
    expect(JSON.parse(json)).toEqual({ location: 'NYC', units: 'metric' });
  });
});

describe('parseCalls', () => {
  test('full text round-trip', () => {
    const calls = parseCalls(
      'I will check\n<call>getWeather location="Austin"</call>\nand respond.',
      [weatherPlan],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe('getWeather');
    expect(JSON.parse(calls[0]!.input)).toEqual({ location: 'Austin' });
  });

  test('throws on unknown tool', () => {
    expect(() => parseCalls('<call>nope x=1</call>', [weatherPlan])).toThrow(/Unknown tool/);
  });
});
