import { describe, expect, test } from 'bun:test';
import { parseCalls } from '../src/parser.ts';
import { serializeCall } from '../src/serialize.ts';
import { planTools } from '../src/signature.ts';
import { cases, providerTools } from '../bench/tools.ts';

const plans = planTools(providerTools, { syntax: 'wire', fallbackToJson: 'complex' });
const planByName = new Map(plans.map(p => [p.name, p]));

describe('round-trip: bench compactCall → parseCalls → expected nativeCall', () => {
  for (const c of cases) {
    test(`parse: ${c.name}`, () => {
      const parsed = parseCalls(c.compactCall, plans);
      expect(parsed).toHaveLength(1);
      const got = JSON.parse(parsed[0]!.input);
      expect(parsed[0]!.toolName).toBe(c.nativeCall.name);
      expect(got).toEqual(c.nativeCall.arguments);
    });
  }
});

describe('round-trip: nativeCall → serializeCall → parseCalls is stable', () => {
  for (const c of cases) {
    test(`serialize+parse: ${c.name}`, () => {
      const plan = planByName.get(c.nativeCall.name);
      const serialized = serializeCall(
        c.nativeCall.name,
        JSON.stringify(c.nativeCall.arguments),
        plan,
      );
      // Should produce a valid <call>…</call>
      expect(serialized.startsWith('<call>')).toBe(true);
      expect(serialized.endsWith('</call>')).toBe(true);
      // Re-parse it and confirm the arguments survive the round trip.
      const parsed = parseCalls(serialized, plans);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.toolName).toBe(c.nativeCall.name);
      expect(JSON.parse(parsed[0]!.input)).toEqual(c.nativeCall.arguments);
    });
  }
});

describe('round-trip: idempotence — serialize ∘ parse ∘ serialize ≡ serialize', () => {
  for (const c of cases) {
    test(`idempotent: ${c.name}`, () => {
      const plan = planByName.get(c.nativeCall.name);
      const s1 = serializeCall(
        c.nativeCall.name,
        JSON.stringify(c.nativeCall.arguments),
        plan,
      );
      const parsed = parseCalls(s1, plans)[0]!;
      const s2 = serializeCall(parsed.toolName, parsed.input, plan);
      // Re-parsing both should yield identical structured inputs.
      expect(JSON.parse(parseCalls(s2, plans)[0]!.input)).toEqual(
        JSON.parse(parseCalls(s1, plans)[0]!.input),
      );
    });
  }
});
