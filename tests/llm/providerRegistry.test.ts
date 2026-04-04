jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));

import { registry } from '../../src/llm/providerRegistry';
import type { LLMProvider } from '../../src/llm/provider';

function makeProvider(name: string): LLMProvider {
  return {
    name,
    call: async () => ({ text: `from-${name}`, toolUsage: [] }),
  };
}

describe('ProviderRegistry', () => {
  it('has claude-agent registered by default', () => {
    const provider = registry.get('claude-agent');
    expect(provider.name).toBe('claude-agent');
  });

  it('returns default provider when name is undefined', () => {
    const provider = registry.get(undefined);
    expect(provider).toBeDefined();
  });

  it('registers and retrieves a provider by name', () => {
    registry.register(makeProvider('custom-1'));
    const provider = registry.get('custom-1');
    expect(provider.name).toBe('custom-1');
  });

  it('throws on unknown provider name', () => {
    expect(() => registry.get('nonexistent-provider')).toThrow(/not found.*nonexistent-provider/);
  });

  it('setDefault changes the default provider', async () => {
    registry.register(makeProvider('new-default'));
    registry.setDefault('new-default');
    const provider = registry.get();
    expect(provider.name).toBe('new-default');

    // Reset
    registry.setDefault('claude-agent');
  });

  it('setDefault throws if provider is not registered', () => {
    expect(() => registry.setDefault('not-registered')).toThrow(/not registered/);
  });

  it('getDefaultName returns current default', () => {
    expect(registry.getDefaultName()).toBe('claude-agent');
  });

  it('overwrites provider on re-register with same name', async () => {
    const p1 = makeProvider('overwrite-test');
    const p2: LLMProvider = {
      name: 'overwrite-test',
      call: async () => ({ text: 'replaced', toolUsage: [] }),
    };
    registry.register(p1);
    registry.register(p2);
    const result = await registry.get('overwrite-test').call({ system: '', prompt: '' });
    expect(result.text).toBe('replaced');
  });
});
