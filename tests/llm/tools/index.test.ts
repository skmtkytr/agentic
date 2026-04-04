import { getToolHandlers, NATIVE_TOOL_NAMES } from '../../../src/llm/tools/index';

describe('tool registry', () => {
  it('returns empty map for no allowedTools', () => {
    expect(getToolHandlers().size).toBe(0);
    expect(getToolHandlers([]).size).toBe(0);
  });

  it('returns handlers for known tools', () => {
    const handlers = getToolHandlers(['WebSearch', 'WebFetch', 'Read']);
    expect(handlers.size).toBe(3);
    expect(handlers.has('WebSearch')).toBe(true);
    expect(handlers.has('WebFetch')).toBe(true);
    expect(handlers.has('Read')).toBe(true);
  });

  it('ignores unknown tools', () => {
    const handlers = getToolHandlers(['WebSearch', 'UnknownTool', 'NotebookEdit']);
    expect(handlers.size).toBe(1);
    expect(handlers.has('WebSearch')).toBe(true);
  });

  it('exports NATIVE_TOOL_NAMES with all built-in tools', () => {
    expect(NATIVE_TOOL_NAMES).toContain('WebSearch');
    expect(NATIVE_TOOL_NAMES).toContain('WebFetch');
    expect(NATIVE_TOOL_NAMES).toContain('Read');
    expect(NATIVE_TOOL_NAMES).toContain('Write');
    expect(NATIVE_TOOL_NAMES).toContain('Bash');
    expect(NATIVE_TOOL_NAMES.length).toBe(5);
  });
});
