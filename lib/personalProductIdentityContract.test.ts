import { buildProductAttributes } from './productIdentityContract';
import {
  PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
  buildPersonalDecisionGraph,
  buildPersonalMerchantProductEndpointV1,
  buildStructuralSignatureFromAttributes,
  normalizePersonalProductIdentityPair,
  precheckPersonalDecisionWrite,
  resolvePersonalProductIdentityOwnerKey,
  validatePersonalMerchantProductEndpointV1,
} from './personalProductIdentityContract';

function endpoint(
  id: string,
  scope = 'lawson',
  comparisonKey = `cmp-${id}`,
  attributes = buildProductAttributes([
    { dimension: 'volume', value: 500, unit: 'ml' },
  ]),
  identityPipelineVersion?: string
) {
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: scope,
    comparisonKey,
    attributes,
    identityPipelineVersion,
  });
}

describe('G4-1 personal product identity contract', () => {
  describe('CONTRACT', () => {
    it('unordered pair A/B == B/A', () => {
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const forward = normalizePersonalProductIdentityPair(a, b);
      const reverse = normalizePersonalProductIdentityPair(b, a);
      expect(forward.ok && reverse.ok).toBe(true);
      if (forward.ok && reverse.ok) {
        expect(forward.pair).toEqual(reverse.pair);
        expect(forward.pair.leftMerchantProductId).toBe('mp_a');
        expect(forward.pair.rightMerchantProductId).toBe('mp_b');
      }
    });

    it('swaps all endpoint descriptor fields together when pair order is reversed', () => {
      const leftInput = buildPersonalMerchantProductEndpointV1({
        merchantProductId: 'mp_b',
        merchantScopeKey: 'scope-b',
        comparisonKey: 'cmp-b',
        attributes: buildProductAttributes([
          { dimension: 'volume', value: 500, unit: 'ml' },
        ]),
        identityPipelineVersion: `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-swap`,
      });
      const rightInput = buildPersonalMerchantProductEndpointV1({
        merchantProductId: 'mp_a',
        merchantScopeKey: 'scope-a',
        comparisonKey: 'cmp-a',
        attributes: buildProductAttributes([
          { dimension: 'volume', value: 1000, unit: 'ml' },
        ]),
        identityPipelineVersion: `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-swap`,
      });
      const normalized = normalizePersonalProductIdentityPair(leftInput, rightInput);
      expect(normalized.ok).toBe(true);
      if (!normalized.ok) return;
      expect(normalized.pair.left).toEqual(rightInput);
      expect(normalized.pair.right).toEqual(leftInput);
      expect(normalized.pair.left.merchantScopeKey).toBe('scope-a');
      expect(normalized.pair.right.merchantScopeKey).toBe('scope-b');
      expect(normalized.pair.left.comparisonKey).toBe('cmp-a');
      expect(normalized.pair.right.comparisonKey).toBe('cmp-b');
      expect(normalized.pair.left.structuralSignature).not.toBe(
        normalized.pair.right.structuralSignature
      );
      expect(normalized.pair.left.identityPipelineVersion).toBe(
        normalized.pair.right.identityPipelineVersion
      );
    });

    it('rejects identity pipeline version mismatch for A/B and B/A', () => {
      const a = endpoint(
        'mp_a',
        'lawson',
        'cmp-a',
        buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }]),
        `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-v1`
      );
      const b = endpoint(
        'mp_b',
        'lawson',
        'cmp-b',
        buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }]),
        `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-v2`
      );
      expect(normalizePersonalProductIdentityPair(a, b)).toEqual({
        ok: false,
        code: 'identity_pipeline_version_mismatch',
      });
      expect(normalizePersonalProductIdentityPair(b, a)).toEqual({
        ok: false,
        code: 'identity_pipeline_version_mismatch',
      });
    });

    it('rejects self pair', () => {
      const a = endpoint('mp_a');
      expect(normalizePersonalProductIdentityPair(a, a)).toEqual({
        ok: false,
        code: 'self_pair',
      });
    });

    it('rejects malformed endpoint', () => {
      const valid = endpoint('mp_b');
      const invalid = buildPersonalMerchantProductEndpointV1({
        merchantProductId: ' ',
        merchantScopeKey: 'lawson',
        comparisonKey: 'cmp',
        attributes: buildProductAttributes([]),
      });
      const result = normalizePersonalProductIdentityPair(invalid, valid);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('invalid_endpoint');
      }
    });

    it('rejects unknown merchant scope', () => {
      const unknown = endpoint('mp_a', 'unknown_merchant');
      const valid = endpoint('mp_b');
      expect(
        validatePersonalMerchantProductEndpointV1(unknown).ok
      ).toBe(false);
      expect(
        normalizePersonalProductIdentityPair(unknown, valid).ok
      ).toBe(false);
    });

    it('builds deterministic structural signature', () => {
      const attrs = buildProductAttributes([
        { dimension: 'pack_count', value: 6, unit: 'count' },
        { dimension: 'volume', value: 500, unit: 'ml' },
      ]);
      const first = buildStructuralSignatureFromAttributes(attrs);
      const second = buildStructuralSignatureFromAttributes(attrs);
      expect(first).toBe(second);
      expect(first).toContain('volume');
      expect(first).toContain('pack_count');
    });

    it('structural spec change changes signature', () => {
      const fiveHundred = buildStructuralSignatureFromAttributes(
        buildProductAttributes([{ dimension: 'volume', value: 500, unit: 'ml' }])
      );
      const oneThousand = buildStructuralSignatureFromAttributes(
        buildProductAttributes([
          { dimension: 'volume', value: 1000, unit: 'ml' },
        ])
      );
      const sixPack = buildStructuralSignatureFromAttributes(
        buildProductAttributes([
          { dimension: 'pack_count', value: 6, unit: 'count' },
        ])
      );
      const twelvePack = buildStructuralSignatureFromAttributes(
        buildProductAttributes([
          { dimension: 'pack_count', value: 12, unit: 'count' },
        ])
      );
      expect(fiveHundred).not.toBe(oneThousand);
      expect(sixPack).not.toBe(twelvePack);
    });
  });

  describe('OWNER', () => {
    it('uses authenticated user owner key', () => {
      expect(
        resolvePersonalProductIdentityOwnerKey({
          userId: 'user-123',
          installationId: 'install-456',
        })
      ).toBe('user:user-123');
    });

    it('falls back to installation owner key', () => {
      expect(
        resolvePersonalProductIdentityOwnerKey({
          userId: null,
          installationId: 'install-456',
        })
      ).toBe('installation:install-456');
    });

    it('fails closed without user and installation', () => {
      expect(
        resolvePersonalProductIdentityOwnerKey({
          userId: null,
          installationId: null,
        })
      ).toBeNull();
    });
  });

  it('pipeline version uses resolver version composition', () => {
    expect(endpoint('mp_a').identityPipelineVersion).toBe(
      PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION
    );
  });

  describe('WRITE PRECEDENCE', () => {
    function graphForRows(
      ...rows: Array<{
        left: string;
        right: string;
        decision: 'same_product' | 'not_same_product' | 'unsure';
      }>
    ) {
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const d = endpoint('mp_d');
      const byId = {
        mp_a: a,
        mp_b: b,
        mp_c: c,
        mp_d: d,
      } as const;
      const stored = rows.map((row) => {
        const left = byId[row.left as keyof typeof byId];
        const right = byId[row.right as keyof typeof byId];
        const [leftEndpoint, rightEndpoint] =
          left.merchantProductId < right.merchantProductId
            ? [left, right]
            : [right, left];
        return {
          ownerKey: 'user:test',
          leftMerchantProductId: leftEndpoint.merchantProductId,
          rightMerchantProductId: rightEndpoint.merchantProductId,
          leftMerchantScopeKey: leftEndpoint.merchantScopeKey,
          rightMerchantScopeKey: rightEndpoint.merchantScopeKey,
          leftComparisonKey: leftEndpoint.comparisonKey,
          rightComparisonKey: rightEndpoint.comparisonKey,
          leftStructuralSignature: leftEndpoint.structuralSignature,
          rightStructuralSignature: rightEndpoint.structuralSignature,
          identityPipelineVersion: leftEndpoint.identityPipelineVersion,
          decision: row.decision,
          createdAt: 1,
          updatedAt: 1,
        };
      });
      const snapshot = new Map(
        [a, b, c, d].map((item) => [item.merchantProductId, item] as const)
      );
      const built = buildPersonalDecisionGraph(stored, snapshot);
      if (!built.ok) {
        throw new Error('expected complete snapshot in test');
      }
      return built.graph;
    }

    it.each([
      ['same_product', 'not_same_product', 'personal_same_component_conflict'],
      ['not_same_product', 'same_product', 'personal_not_same_conflict'],
      ['same_product', 'unsure', 'decision_conflict'],
      ['not_same_product', 'unsure', 'decision_conflict'],
      ['unsure', 'same_product', 'decision_conflict'],
      ['unsure', 'not_same_product', 'decision_conflict'],
    ] as const)(
      'direct %s -> %s returns %s',
      (existing, requested, expected) => {
        const graph = graphForRows({ left: 'mp_a', right: 'mp_b', decision: existing });
        expect(
          precheckPersonalDecisionWrite(
            graph,
            existing,
            requested,
            'mp_a',
            'mp_b'
          )
        ).toEqual({
          ok: false,
          code: expected,
          existingDecision: existing,
        });
      }
    );

    it('A=B,B=C then A!=C returns personal_same_component_conflict', () => {
      const graph = graphForRows(
        { left: 'mp_a', right: 'mp_b', decision: 'same_product' },
        { left: 'mp_b', right: 'mp_c', decision: 'same_product' }
      );
      expect(
        precheckPersonalDecisionWrite(
          graph,
          null,
          'not_same_product',
          'mp_a',
          'mp_c'
        )
      ).toEqual({ ok: false, code: 'personal_same_component_conflict' });
    });

    it('A!=B then A=B returns personal_not_same_conflict', () => {
      const graph = graphForRows({
        left: 'mp_a',
        right: 'mp_b',
        decision: 'not_same_product',
      });
      expect(
        precheckPersonalDecisionWrite(
          graph,
          'not_same_product',
          'same_product',
          'mp_a',
          'mp_b'
        )
      ).toEqual({
        ok: false,
        code: 'personal_not_same_conflict',
        existingDecision: 'not_same_product',
      });
    });
  });
});
