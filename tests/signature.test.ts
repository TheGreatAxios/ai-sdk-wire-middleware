import { describe, expect, test } from 'bun:test';
import { isFlatObject, planTools, renderSignature } from '../src/signature.ts';
import type { FunctionTool } from '../src/types.ts';

const flatTool: FunctionTool = {
  type: 'function',
  name: 'getWeather',
  description: 'Get weather',
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      units: { type: 'string', enum: ['metric', 'imperial'] },
    },
    required: ['location'],
  },
};

const nestedTool: FunctionTool = {
  type: 'function',
  name: 'createUser',
  inputSchema: {
    type: 'object',
    properties: {
      profile: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
      },
    },
    required: ['profile'],
  },
};

describe('isFlatObject', () => {
  test('flat schema', () => {
    expect(isFlatObject(flatTool.inputSchema as any)).toBe(true);
  });
  test('nested schema', () => {
    expect(isFlatObject(nestedTool.inputSchema as any)).toBe(false);
  });
});

describe('renderSignature', () => {
  test('wire', () => {
    expect(renderSignature(flatTool, 'wire')).toContain('location:string');
    expect(renderSignature(flatTool, 'wire')).toContain('units?:"metric"|"imperial"');
  });
  test('description appended', () => {
    expect(renderSignature(flatTool, 'wire')).toMatch(/— Get weather/);
  });
});

describe('planTools', () => {
  test('flat tool stays in chosen encoding', () => {
    const [plan] = planTools([flatTool], { syntax: 'wire', fallbackToJson: 'complex' });
    expect(plan!.encoding).toBe('wire');
  });
  test('nested tool falls back to json', () => {
    const [plan] = planTools([nestedTool], { syntax: 'wire', fallbackToJson: 'complex' });
    expect(plan!.encoding).toBe('json');
  });
  test('error mode throws', () => {
    expect(() => planTools([nestedTool], { syntax: 'wire', fallbackToJson: 'error' })).toThrow();
  });
});
