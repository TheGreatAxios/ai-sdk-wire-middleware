import { describe, expect, test } from 'bun:test';
import { xmlEncodeCall, xmlEncodeManual } from '../bench/encoders/xml-anthropic.ts';
import { pyEncodeCall, pyEncodeManual } from '../bench/encoders/python-dsl.ts';

import { planTools } from '../src/signature.ts';
import { cases, providerTools } from '../bench/tools.ts';

const plans = planTools(providerTools, { syntax: 'wire', fallbackToJson: 'complex' });

describe('xml-anthropic encoder', () => {
  for (const c of cases) {
    test(`encodeCall is deterministic and well-formed: ${c.name}`, () => {
      const out = xmlEncodeCall(c.nativeCall.name, c.nativeCall.arguments);
      const out2 = xmlEncodeCall(c.nativeCall.name, c.nativeCall.arguments);
      expect(out).toBe(out2);
      expect(out.startsWith('<tool_use>')).toBe(true);
      expect(out.endsWith('</tool_use>')).toBe(true);
      expect(out).toContain(`<tool_name>${c.nativeCall.name}</tool_name>`);
      for (const k of Object.keys(c.nativeCall.arguments)) {
        expect(out).toContain(`name="${k}"`);
      }
    });
  }

  test('manual lists every tool', () => {
    const m = xmlEncodeManual(plans);
    for (const p of plans) expect(m).toContain(`<name>${p.name}</name>`);
  });

  test('special characters in args are escaped', () => {
    const out = xmlEncodeCall('x', { q: '<>&"' });
    expect(out).toContain('&lt;&gt;&amp;&quot;');
  });
});

describe('python-dsl encoder', () => {
  for (const c of cases) {
    test(`encodeCall is deterministic and parses-shaped: ${c.name}`, () => {
      const out = pyEncodeCall(c.nativeCall.name, c.nativeCall.arguments);
      const out2 = pyEncodeCall(c.nativeCall.name, c.nativeCall.arguments);
      expect(out).toBe(out2);
      expect(out.startsWith(`${c.nativeCall.name}(`)).toBe(true);
      expect(out.endsWith(')')).toBe(true);
    });
  }

  test('booleans render as Python literals', () => {
    expect(pyEncodeCall('x', { a: true, b: false })).toBe('x(a=True, b=False)');
  });

  test('null renders as None', () => {
    expect(pyEncodeCall('x', { a: null })).toBe('x(a=None)');
  });

  test('strings are JSON-quoted', () => {
    expect(pyEncodeCall('x', { s: 'hi "you"' })).toContain('"hi \\"you\\""');
  });

  test('manual contains every tool name', () => {
    const m = pyEncodeManual(plans);
    for (const p of plans) expect(m).toContain(p.name);
  });
});


