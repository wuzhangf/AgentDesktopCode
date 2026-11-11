import { describe, expect, it } from 'vitest';
import { modelCatalogEntryMatches, modelCatalogEntryRef } from '../../src/renderer/app/queries';

/**
 * ModelCatalogResponse.defaultModel and stored session/profile aliases are
 * provider-qualified refs ("provider/alias"), while catalog entries carry a
 * bare modelAlias plus providerId. The selectors used to compare alias
 * literally, so a stored ref resolved to no entry: the model looked
 * "当前不可用" and the usage panel reported 暂无数据 for context and cache.
 */
describe('model catalog ref matching', () => {
  const entry = { providerId: 'commandcode-chat', modelAlias: 'mimo-v2.6-flash' };

  it('builds the provider-qualified ref from providerId and alias', () => {
    expect(modelCatalogEntryRef(entry)).toBe('commandcode-chat/mimo-v2.6-flash');
    expect(modelCatalogEntryRef({ providerId: null, modelAlias: 'solo' })).toBe('solo');
    expect(modelCatalogEntryRef({ modelAlias: 'solo' })).toBe('solo');
  });

  it('matches both the bare alias and the provider-qualified ref', () => {
    expect(modelCatalogEntryMatches(entry, 'mimo-v2.6-flash')).toBe(true);
    expect(modelCatalogEntryMatches(entry, 'commandcode-chat/mimo-v2.6-flash')).toBe(true);
  });

  it('rejects unrelated and empty refs', () => {
    expect(modelCatalogEntryMatches(entry, 'other-provider/mimo-v2.6-flash')).toBe(false);
    expect(modelCatalogEntryMatches(entry, 'other-model')).toBe(false);
    expect(modelCatalogEntryMatches(entry, null)).toBe(false);
    expect(modelCatalogEntryMatches(entry, undefined)).toBe(false);
    expect(modelCatalogEntryMatches(entry, '')).toBe(false);
  });
});
