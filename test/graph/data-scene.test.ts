import { describe, expect, it } from 'vitest';
import { edgeLabelWidth } from '../../src/webview/engine/scene';
import { buildDataScene, nodeKey, type DataGraphState, type DataSceneOptions } from '../../src/webview/scenes/data-graph';
import type { CardData, NodeInfo } from '../../src/webview/worker/protocol';

const row = (id: number, key: string | number, type: NodeInfo['type'], count = 0): NodeInfo => ({ id, key, type, preview: '', count });
const card = (info: NodeInfo, rows: NodeInfo[]): CardData => ({ ...info, rows, more: 0 });

// { configuration: { a: 1 }, users: [ { id: 1 } ] }
const root = card({ id: 0, key: null, type: 'object', preview: '', count: 2 }, [row(1, 'configuration', 'object', 1), row(3, 'users', 'array', 1)]);
const cards = [
  root,
  card(row(1, 'configuration', 'object', 1), [row(2, 'a', 'number')]),
  card(row(3, 'users', 'array', 1), [row(4, 0, 'object', 1)]),
  card(row(4, 0, 'object', 1), [row(5, 'id', 'number')]),
];
const state = (): DataGraphState => ({ root: 0, cards: new Map(cards.map((c) => [c.id, c])), expanded: new Set([0, 1, 3, 4]), rowLimits: new Map() });
const opts = (o: Partial<DataSceneOptions> = {}): DataSceneOptions => ({ direction: 'LR', charW: 7, rootTitle: 'doc.json', xml: false, pageSize: 50, ...o });

describe('buildDataScene edge labels', () => {
  it('labels each edge with the key it leads to', () => {
    const s = buildDataScene(state(), opts({ edgeLabels: true }));
    const labels = Object.fromEntries(s.edges.map((e) => [e.to, e.label]));
    expect(labels).toEqual({ [nodeKey(1)]: 'configuration', [nodeKey(3)]: 'users', [nodeKey(4)]: '[0]' });
  });

  it('leaves edges unlabelled when turned off', () => {
    const s = buildDataScene(state(), opts());
    expect(s.edges.every((e) => e.label === undefined)).toBe(true);
  });

  it('widens each column gap to fit its widest label', () => {
    for (const direction of ['LR', 'TB'] as const) {
      const plain = buildDataScene(state(), opts({ direction }));
      const labelled = buildDataScene(state(), opts({ direction, edgeLabels: true }));
      const at = (s: typeof plain, id: number) => s.nodes.find((n) => n.key === nodeKey(id))!;
      if (direction === 'LR') {
        const gap = at(labelled, 1).x - (at(labelled, 0).x + at(labelled, 0).w);
        expect(gap).toBeGreaterThanOrEqual(edgeLabelWidth('configuration', 7) + 30);
        // Depth 1 → 2 only carries the short `[0]` label: the default gap is enough.
        const gap2 = at(labelled, 4).x - Math.max(at(labelled, 1).x + at(labelled, 1).w, at(labelled, 3).x + at(labelled, 3).w);
        expect(gap2).toBeCloseTo(at(plain, 4).x - Math.max(at(plain, 1).x + at(plain, 1).w, at(plain, 3).x + at(plain, 3).w));
      } else {
        expect(at(labelled, 1).y).toBeGreaterThan(at(plain, 1).y);
      }
    }
  });
});
