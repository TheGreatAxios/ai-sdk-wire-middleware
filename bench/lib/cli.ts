/**
 * Tiny argv parser. We don't need a CLI framework dependency.
 *
 * Supports:
 *   --models a,b,c              CSV list (legacy, used as fallback)
 *   --provider-models p=a,b,c   Repeatable: models scoped to a provider
 *   --cases x,y                 CSV list
 *   --reps 3                    number
 *   --judge-model m
 *   --kind live|offline|agent
 *   --resume <file>             path to JSONL artifact to resume from
 *   --ablation key=value        repeatable
 *   --dry                       boolean
 *   --out <file>                override artifact path
 *   --help / -h
 *
 * Booleans accept `--flag` or `--flag=true|false`. Unknown flags are kept
 * in `parsed.unknown` so callers can decide whether to error.
 */
export interface ParsedArgs {
  models?: string[];
  /** Provider-scoped model lists: e.g. { openrouter: [...], zai: [...] } */
  providerModels: Record<string, string[]>;
  cases?: string[];
  reps?: number;
  judgeModel?: string;
  kind?: 'live' | 'offline' | 'agent';
  resume?: string;
  out?: string;
  ablations: Record<string, string>;
  dry: boolean;
  help: boolean;
  unknown: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { ablations: {}, providerModels: {}, dry: false, help: false, unknown: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--dry') {
      out.dry = true;
      continue;
    }
    if (!a.startsWith('--')) continue;

    const eq = a.indexOf('=');
    let key: string;
    let val: string | undefined;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i++;
      }
    }
    switch (key) {
      case 'models':
        out.models = csv(val);
        break;
      case 'provider-models':
        if (val) {
          const eqIdx = val.indexOf('=');
          if (eqIdx !== -1) {
            const p = val.slice(0, eqIdx);
            const m = val.slice(eqIdx + 1);
            if (p) out.providerModels[p] = csv(m) ?? [];
          } else {
            out.unknown['provider-models'] = val;
          }
        }
        break;
      case 'cases':
        out.cases = csv(val);
        break;
      case 'reps':
        out.reps = val !== undefined ? Number(val) : undefined;
        break;
      case 'judge-model':
        out.judgeModel = val;
        break;
      case 'kind':
        out.kind = (val as ParsedArgs['kind']) ?? undefined;
        break;
      case 'resume':
        out.resume = val;
        break;
      case 'out':
        out.out = val;
        break;
      case 'ablation':
        if (val) {
          const [k, ...rest] = val.split('=');
          if (k) out.ablations[k] = rest.join('=') || 'true';
        }
        break;
      case 'dry':
        out.dry = val ? val !== 'false' : true;
        break;
      default:
        out.unknown[key] = val ?? true;
    }
  }
  return out;
}

function csv(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function helpText(): string {
  return `\nUsage: bun run bench/<script>.ts [options]\n\n` +
    `  --models a,b,c                  Override the model list (CSV, legacy fallback)\n` +
    `  --provider-models provider=a,b  Repeatable: models scoped to a provider\n` +
    `                                    e.g. --provider-models openrouter=m1,m2\n` +
    `                                         --provider-models zai=m3,m4\n` +
    `                                    Env vars: OPENROUTER_MODELS, ZAI_MODELS\n` +
    `  --cases x,y                     Run only these cases by name (CSV)\n` +
    `  --reps 3                        Repetitions per (model, case, mode) cell\n` +
    `  --judge-model m                 LLM judge model id (OpenRouter slug)\n` +
    `  --kind live|offline|agent\n` +
    `  --resume <file>                 Resume from existing JSONL artifact (skip present cells)\n` +
    `  --ablation key=value            Tag rows with an ablation label (repeatable)\n` +
    `  --out <file>                    Override artifact output path\n` +
    `  --dry                           Print plan and exit without making API calls\n`;
}
