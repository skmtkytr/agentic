import type { LLMProvider } from './provider';
import { ClaudeAgentProvider } from './providers/claudeAgent';

const DEFAULT_PROVIDER_NAME = 'claude-agent';

class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private defaultName: string = DEFAULT_PROVIDER_NAME;

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name?: string): LLMProvider {
    const key = name ?? this.defaultName;
    const provider = this.providers.get(key);
    if (!provider) {
      throw new Error(
        `LLM provider not found: "${key}". Registered: [${[...this.providers.keys()].join(', ')}]`,
      );
    }
    return provider;
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Cannot set default: provider "${name}" not registered`);
    }
    this.defaultName = name;
  }

  getDefaultName(): string {
    return this.defaultName;
  }
}

export const registry = new ProviderRegistry();

// Register the default provider
registry.register(new ClaudeAgentProvider());
