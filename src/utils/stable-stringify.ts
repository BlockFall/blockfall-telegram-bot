type Replacer = (this: object, key: string, value: unknown) => unknown;
interface CmpEntry {
  key: string;
  value: unknown;
}
type CmpFunction = (a: CmpEntry, b: CmpEntry) => number;

export interface StableStringifyOptions {
  space?: string | number;
  cycles?: boolean;
  replacer?: Replacer;
  cmp?: CmpFunction;
}

export default function stableStringify(
  obj: unknown,
  opts?: StableStringifyOptions | CmpFunction
): string | undefined {
  const options: StableStringifyOptions = typeof opts === 'function' ? { cmp: opts } : (opts ?? {});

  let space = '';
  if (typeof options.space === 'number') {
    space = ' '.repeat(options.space);
  } else {
    space = options.space ?? '';
  }

  const cycles = options.cycles === true;
  const replacer: Replacer =
    options.replacer ??
    function (_key, value) {
      return value;
    };

  const cmp = options.cmp
    ? (
        (f: CmpFunction) =>
        (node: Record<string, unknown>) =>
        (a: string, b: string): number =>
          f({ key: a, value: node[a] }, { key: b, value: node[b] })
      )(options.cmp)
    : undefined;

  const seen: object[] = [];

  function stringify(
    parent: object,
    key: string | number,
    node: unknown,
    level: number
  ): string | undefined {
    const indent = space ? '\n' + space.repeat(level) : '';
    const colonSeparator = space ? ': ' : ':';

    if (
      node !== null &&
      typeof node === 'object' &&
      'toJSON' in node &&
      typeof (node as Record<string, unknown>)['toJSON'] === 'function'
    ) {
      node = (node as { toJSON: () => unknown }).toJSON();
    }

    node = replacer.call(parent, String(key), node);

    if (node === undefined) {
      return undefined;
    }

    if (typeof node !== 'object' || node === null) {
      return JSON.stringify(node);
    }

    if (Array.isArray(node)) {
      const items: string[] = [];
      for (let i = 0; i < node.length; i++) {
        const item = stringify(node, i, node[i], level + 1) ?? JSON.stringify(null);
        items.push(indent + space + item);
      }
      return '[' + items.join(',') + indent + ']';
    }

    if (seen.includes(node)) {
      if (cycles) return JSON.stringify('__cycle__');
      throw new TypeError('Converting circular structure to JSON');
    }
    seen.push(node);

    const nodeRecord = node as Record<string, unknown>;
    const keys = Object.keys(nodeRecord).sort(cmp ? cmp(nodeRecord) : undefined);
    const pairs: string[] = [];
    for (const k of keys) {
      const value = stringify(nodeRecord, k, nodeRecord[k], level + 1);
      if (value === undefined) continue;
      pairs.push(indent + space + JSON.stringify(k) + colonSeparator + value);
    }

    seen.splice(seen.indexOf(node), 1);
    return '{' + pairs.join(',') + indent + '}';
  }

  return stringify({ '': obj }, '', obj, 0);
}
