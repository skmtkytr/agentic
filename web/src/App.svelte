<script lang="ts">
  import { onMount } from 'svelte';

  type Phase =
    | 'planning'
    | 'validating'
    | 'executing'
    | 'integrating'
    | 'reviewing'
    | 'complete'
    | 'failed';

  interface ActivityEvent {
    kind: string;
    timestamp: number;
    taskId?: string;
    taskDescription?: string;
    summary: string;
  }

  interface TaskState {
    id: string;
    description: string;
    dependsOn: string[];
    status: 'pending' | 'executing' | 'executed' | 'reviewed' | 'rejected';
    result?: string;
    reviewNotes?: string;
    reviewPassed: boolean;
  }

  interface WorkflowState {
    phase: Phase;
    totalTasks: number;
    completedTasks: number;
    currentlyExecuting: string[];
    events: ActivityEvent[];
    tasks: TaskState[];
  }

  interface WorkflowResult {
    finalResponse: string;
    integrationReviewPassed: boolean;
    integrationReviewNotes: string;
    tasks: TaskState[];
    executionTimeMs: number;
  }

  interface HistoryEntry {
    workflowId: string;
    status: string;
    startTime: string;
    prompt?: string;
  }

  const PHASES: Phase[] = ['planning', 'validating', 'executing', 'integrating', 'reviewing', 'complete'];
  const PHASE_LABELS: Record<string, string> = {
    planning: 'Planning', validating: 'Validating', executing: 'Executing',
    integrating: 'Integrating', reviewing: 'Reviewing', complete: 'Complete',
  };

  const AVAILABLE_TOOLS = [
    { id: 'Read', label: 'Read', desc: 'ファイル読み取り' },
    { id: 'Write', label: 'Write', desc: 'ファイル書き込み' },
    { id: 'Edit', label: 'Edit', desc: 'ファイル編集' },
    { id: 'Bash', label: 'Bash', desc: 'シェルコマンド実行' },
    { id: 'Glob', label: 'Glob', desc: 'パターン検索' },
    { id: 'Grep', label: 'Grep', desc: '内容検索' },
    { id: 'WebFetch', label: 'WebFetch', desc: 'URL取得' },
    { id: 'WebSearch', label: 'WebSearch', desc: 'Web検索' },
    { id: 'NotebookEdit', label: 'NotebookEdit', desc: 'Jupyter' },
    { id: 'Task', label: 'Task', desc: 'サブタスク委譲' },
    { id: 'ToolSearch', label: 'ToolSearch', desc: 'ツール検索' },
  ] as const;

  let prompt = $state('');
  let model = $state('claude-opus-4-6');
  let enabledTools = $state<Set<string>>(new Set());
  let workflowId = $state<string | null>(null);
  let wfState = $state<WorkflowState | null>(null);
  let result = $state<WorkflowResult | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let expandedTasks = $state<Set<string>>(new Set());
  let workflowHistory = $state<HistoryEntry[]>([]);
  let sidebarOpen = $state(false);
  let currentSse: EventSource | null = null;
  let eventLogEl: HTMLElement | undefined = $state();

  function syncHashToState() {
    const hash = location.hash.replace('#', '');
    if (hash && hash.startsWith('agentic-')) openWorkflow(hash);
  }

  function setHash(id: string | null) {
    if (id) history.replaceState(null, '', `#${id}`);
    else history.replaceState(null, '', location.pathname);
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/workflows');
      if (res.ok) workflowHistory = (await res.json()) as HistoryEntry[];
    } catch { /* ignore */ }
  }

  async function openWorkflow(id: string) {
    if (currentSse) { currentSse.close(); currentSse = null; }
    workflowId = id;
    wfState = null;
    result = null;
    error = null;
    loading = true;
    expandedTasks = new Set();
    setHash(id);
    sidebarOpen = false;

    try {
      const detailRes = await fetch(`/api/workflow/${id}`);
      if (!detailRes.ok) { error = 'Workflow not found'; loading = false; return; }
      const detail = (await detailRes.json()) as { status: string };

      if (detail.status === 'COMPLETED') await fetchResult(id);
      else if (detail.status === 'RUNNING') connectSse(id);
      else { error = `Workflow status: ${detail.status}`; loading = false; }
    } catch (e) { error = (e as Error).message; loading = false; }
  }

  function connectSse(id: string) {
    const sse = new EventSource(`/api/status/${id}`);
    currentSse = sse;
    sse.onmessage = (e) => {
      const data = JSON.parse(e.data) as { type: string } & WorkflowState;
      if (data.type === 'status') {
        wfState = data;
        requestAnimationFrame(scrollEventLog);
        if (data.phase === 'complete' || data.phase === 'failed') {
          sse.close(); currentSse = null;
          if (data.phase === 'complete') fetchResult(id);
          else { loading = false; error = 'Workflow failed'; }
          loadHistory();
        }
      }
    };
    sse.onerror = () => {
      sse.close(); currentSse = null;
      fetchResult(id).catch(() => { loading = false; });
    };
  }

  function toggleTool(id: string) {
    const next = new Set(enabledTools);
    if (next.has(id)) next.delete(id); else next.add(id);
    enabledTools = next;
  }

  function setToolPreset(preset: 'none' | 'readonly' | 'all') {
    if (preset === 'none') enabledTools = new Set();
    else if (preset === 'readonly') enabledTools = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    else enabledTools = new Set(AVAILABLE_TOOLS.map((t) => t.id));
  }

  function phaseIndex(phase: Phase): number { return PHASES.indexOf(phase); }
  function scrollEventLog() { if (eventLogEl) eventLogEl.scrollTop = eventLogEl.scrollHeight; }

  async function submit() {
    if (!prompt.trim() || loading) return;
    loading = true; error = null; wfState = null; result = null; workflowId = null;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(), model,
          allowedTools: enabledTools.size > 0 ? [...enabledTools] : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? res.statusText);
      }
      const { workflowId: id } = (await res.json()) as { workflowId: string };
      workflowId = id;
      setHash(id);
      connectSse(id);
      loadHistory();
    } catch (e) { error = (e as Error).message; loading = false; }
  }

  async function fetchResult(id: string) {
    try {
      const res = await fetch(`/api/result/${id}`);
      if (!res.ok) throw new Error(res.statusText);
      result = (await res.json()) as WorkflowResult;
      if (!wfState) {
        wfState = {
          phase: 'complete', totalTasks: result.tasks.length,
          completedTasks: result.tasks.length, currentlyExecuting: [],
          events: [], tasks: result.tasks,
        };
      }
    } catch (e) { error = (e as Error).message; }
    finally { loading = false; }
  }

  function toggleTask(id: string) {
    const next = new Set(expandedTasks);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedTasks = next;
  }

  function statusIcon(s: TaskState['status']): string {
    return s === 'reviewed' ? '✓' : s === 'rejected' ? '✗' : s === 'executing' ? '⟳' : s === 'executed' ? '…' : '○';
  }
  function statusColor(s: TaskState['status']): string {
    return s === 'reviewed' ? '#6ee7b7' : s === 'rejected' ? '#f87171' : s === 'executing' ? '#818cf8' : s === 'executed' ? '#fbbf24' : '#475569';
  }
  function eventIcon(k: string): string { return k.endsWith('_start') ? '▶' : k.endsWith('_done') ? '✓' : '·'; }
  function eventColor(k: string): string {
    if (k.startsWith('planner')) return '#a78bfa';
    if (k.startsWith('validator')) return '#67e8f9';
    if (k.startsWith('executor')) return '#818cf8';
    if (k.startsWith('reviewer')) return '#fbbf24';
    if (k.startsWith('integrator')) return '#34d399';
    if (k.startsWith('integration_reviewer')) return '#6ee7b7';
    return '#94a3b8';
  }
  function formatTime(ts: number): string { return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false }); }
  function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  function statusBadge(status: string): { label: string; color: string } {
    switch (status) {
      case 'RUNNING': return { label: '実行中', color: '#818cf8' };
      case 'COMPLETED': return { label: '完了', color: '#6ee7b7' };
      case 'FAILED': return { label: '失敗', color: '#f87171' };
      default: return { label: status, color: '#64748b' };
    }
  }

  function goHome() {
    if (currentSse) { currentSse.close(); currentSse = null; }
    workflowId = null; wfState = null; result = null; error = null;
    loading = false; expandedTasks = new Set();
    setHash(null);
  }

  onMount(() => {
    loadHistory();
    syncHashToState();
    window.addEventListener('hashchange', syncHashToState);
    return () => window.removeEventListener('hashchange', syncHashToState);
  });
</script>

<!-- Mobile sidebar overlay -->
{#if sidebarOpen}
  <button class="overlay" onclick={() => sidebarOpen = false} aria-label="Close sidebar"></button>
{/if}

<div class="layout">
  <!-- Sidebar -->
  <aside class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-header">
      <h2 onclick={goHome} class="clickable">Agentic</h2>
      <button class="new-btn" onclick={() => { goHome(); sidebarOpen = false; }}>+ 新規</button>
    </div>

    <div class="history-list">
      {#each workflowHistory as entry}
        {@const badge = statusBadge(entry.status)}
        <button
          class="history-item"
          class:active={workflowId === entry.workflowId}
          onclick={() => { openWorkflow(entry.workflowId); }}
        >
          <div class="history-top">
            <span class="history-badge" style="color: {badge.color}">{badge.label}</span>
            <span class="history-time">{formatDateTime(entry.startTime)}</span>
          </div>
          <div class="history-prompt">{entry.prompt ?? entry.workflowId.slice(-8)}</div>
        </button>
      {/each}
      {#if workflowHistory.length === 0}
        <p class="history-empty">履歴なし</p>
      {/if}
    </div>
  </aside>

  <!-- Main -->
  <main>
    <!-- Mobile topbar -->
    <div class="topbar">
      <button class="hamburger" onclick={() => { sidebarOpen = !sidebarOpen; if (sidebarOpen) loadHistory(); }} aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
      <h1 onclick={goHome} class="clickable">Agentic Workflow</h1>
    </div>

    {#if !workflowId}
      <section class="input-section">
        <label for="prompt">プロンプト</label>
        <textarea
          id="prompt" bind:value={prompt} rows={4}
          placeholder="例: TypeScript で RESTful API を設計してください"
          disabled={loading}
        ></textarea>

        <div class="form-row">
          <div class="options">
            <label for="model">モデル</label>
            <select id="model" bind:value={model} disabled={loading}>
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            </select>
          </div>
          <button class="submit-btn" onclick={submit} disabled={!prompt.trim() || loading}>
            {loading ? '実行中…' : '実行'}
          </button>
        </div>

        <div class="tools-section">
          <div class="tools-header">
            <span class="tools-label">ツール権限</span>
            <div class="tool-presets">
              <button class="preset-btn" onclick={() => setToolPreset('none')} disabled={loading}>なし</button>
              <button class="preset-btn" onclick={() => setToolPreset('readonly')} disabled={loading}>読取</button>
              <button class="preset-btn" onclick={() => setToolPreset('all')} disabled={loading}>全て</button>
            </div>
          </div>
          <div class="tools-grid">
            {#each AVAILABLE_TOOLS as tool}
              <label class="tool-chip" class:active={enabledTools.has(tool.id)}>
                <input type="checkbox" checked={enabledTools.has(tool.id)} onchange={() => toggleTool(tool.id)} disabled={loading} />
                <span class="tool-name">{tool.label}</span>
                <span class="tool-desc">{tool.desc}</span>
              </label>
            {/each}
          </div>
        </div>

        {#if error}<p class="error">{error}</p>{/if}
      </section>
    {:else}
      <section class="status-section">
        <div class="workflow-header">
          <button class="back-btn" onclick={goHome}>←</button>
          <code class="wf-id">{workflowId.replace('agentic-', '').slice(0, 8)}</code>
        </div>

        {#if wfState}
          <div class="phases">
            {#each PHASES as phase}
              {@const idx = phaseIndex(phase)}
              {@const cur = phaseIndex(wfState.phase)}
              <div class="phase" class:done={idx < cur} class:active={idx === cur} class:pending={idx > cur}>
                <span class="phase-dot"></span>
                <span class="phase-label">{PHASE_LABELS[phase]}</span>
              </div>
            {/each}
          </div>

          {#if wfState.totalTasks > 0}
            <div class="progress-bar-wrap">
              <div class="progress-bar" style="width: {(wfState.completedTasks / wfState.totalTasks) * 100}%"></div>
            </div>
            <p class="progress-text">
              {wfState.completedTasks}/{wfState.totalTasks} tasks
              {#if wfState.currentlyExecuting.length > 0}— {wfState.currentlyExecuting.length} 並列実行中{/if}
            </p>
          {/if}

          {#if wfState.tasks.length > 0}
            <div class="live-tasks">
              {#each wfState.tasks as task}
                <div class="live-task" style="border-left-color: {statusColor(task.status)}">
                  <span class="live-task-icon" style="color: {statusColor(task.status)}">{statusIcon(task.status)}</span>
                  <span class="live-task-desc">{task.description}</span>
                  <span class="live-task-status">{task.status}</span>
                </div>
              {/each}
            </div>
          {/if}

          {#if wfState.events.length > 0}
            <details class="event-log-section" open>
              <summary>アクティビティログ ({wfState.events.length})</summary>
              <div class="event-log" bind:this={eventLogEl}>
                {#each wfState.events as event}
                  <div class="event-row">
                    <span class="event-time">{formatTime(event.timestamp)}</span>
                    <span class="event-icon" style="color: {eventColor(event.kind)}">{eventIcon(event.kind)}</span>
                    <span class="event-summary">{event.summary}</span>
                  </div>
                {/each}
              </div>
            </details>
          {/if}
        {:else if loading}
          <p class="waiting">読み込み中…</p>
        {:else if error}
          <p class="error">{error}</p>
        {/if}
      </section>

      {#if result}
        <section class="result-section">
          <h2>結果</h2>
          <pre class="final-response">{result.finalResponse}</pre>
          <div class="stats">
            <span>{(result.executionTimeMs / 1000).toFixed(1)}s</span>
            <span>{result.tasks.filter((t) => t.reviewPassed).length}/{result.tasks.length} passed</span>
            <span class:passed={result.integrationReviewPassed} class:failed={!result.integrationReviewPassed}>
              統合: {result.integrationReviewPassed ? '✓' : '✗'}
            </span>
          </div>
          {#if result.integrationReviewNotes}
            <p class="review-notes">{result.integrationReviewNotes}</p>
          {/if}

          <details class="task-details">
            <summary>タスク詳細 ({result.tasks.length})</summary>
            <ul class="task-list">
              {#each result.tasks as task}
                <li class="task-item" class:rejected={!task.reviewPassed}>
                  <button class="task-header" onclick={() => toggleTask(task.id)}>
                    <span class="task-icon">{statusIcon(task.status)}</span>
                    <span class="task-desc">{task.description}</span>
                    <span class="task-toggle">{expandedTasks.has(task.id) ? '▲' : '▼'}</span>
                  </button>
                  {#if expandedTasks.has(task.id)}
                    <div class="task-body">
                      {#if task.result}<pre>{task.result}</pre>{/if}
                      {#if task.reviewNotes}<p class="review-note">レビュー: {task.reviewNotes}</p>{/if}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>

          <button class="reset-btn" onclick={goHome}>新規タスク</button>
        </section>
      {/if}
    {/if}
  </main>
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; }

  .layout { display: flex; min-height: 100vh; }

  /* --- Sidebar --- */
  .sidebar {
    width: 280px; flex-shrink: 0; background: #131620; border-right: 1px solid #1e2130;
    display: flex; flex-direction: column; height: 100vh; position: sticky; top: 0;
  }
  .sidebar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1rem 0.75rem; border-bottom: 1px solid #1e2130;
  }
  .sidebar-header h2 { font-size: 1.1rem; margin: 0; color: #f8fafc; }
  h2.clickable, h1.clickable { cursor: pointer; }
  h2.clickable:hover, h1.clickable:hover { color: #818cf8; }
  .new-btn {
    background: #6366f1; color: white; border: none; border-radius: 6px;
    padding: 0.3rem 0.7rem; font-size: 0.75rem; font-weight: 600; cursor: pointer;
  }
  .new-btn:hover { background: #4f46e5; }

  .history-list { flex: 1; overflow-y: auto; padding: 0.5rem; }
  .history-item {
    display: flex; flex-direction: column; gap: 0.2rem; width: 100%;
    background: transparent; border: 1px solid transparent; border-radius: 8px;
    padding: 0.6rem 0.7rem; color: #e2e8f0; cursor: pointer; text-align: left;
    transition: background 0.1s;
  }
  .history-item:hover { background: #1e2130; }
  .history-item.active { background: #1e1b4b; border-color: #4f46e5; }
  .history-top { display: flex; align-items: center; justify-content: space-between; }
  .history-badge { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
  .history-time { font-size: 0.65rem; color: #475569; }
  .history-prompt {
    font-size: 0.8rem; color: #94a3b8; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; line-height: 1.3;
  }
  .history-item.active .history-prompt { color: #cbd5e1; }
  .history-empty { font-size: 0.8rem; color: #475569; text-align: center; padding: 2rem 0; margin: 0; }

  .overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    z-index: 90; border: none; cursor: default;
  }

  /* --- Main --- */
  main { flex: 1; min-width: 0; padding: 1.5rem 2rem; max-width: 900px; }

  .topbar { display: none; }

  .hamburger {
    display: flex; flex-direction: column; gap: 4px; background: none; border: none;
    padding: 0.5rem; cursor: pointer;
  }
  .hamburger span { display: block; width: 20px; height: 2px; background: #94a3b8; border-radius: 1px; }

  h1 { font-size: 1.4rem; font-weight: 700; margin: 0; color: #f8fafc; }

  /* --- Input --- */
  .input-section { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-size: 0.85rem; color: #94a3b8; font-weight: 500; }
  textarea {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 8px;
    color: #e2e8f0; font-size: 0.95rem; padding: 0.75rem;
    resize: vertical; outline: none; transition: border-color 0.15s; font-family: inherit;
  }
  textarea:focus { border-color: #6366f1; }
  .form-row { display: flex; align-items: flex-end; gap: 0.75rem; flex-wrap: wrap; }
  .options { display: flex; align-items: center; gap: 0.5rem; }
  select {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 6px;
    color: #e2e8f0; padding: 0.4rem 0.6rem; font-size: 0.85rem; outline: none;
  }
  .submit-btn {
    background: #6366f1; color: white; border: none; border-radius: 8px;
    padding: 0.55rem 1.5rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
  }
  .submit-btn:hover:not(:disabled) { background: #4f46e5; }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .tools-section { display: flex; flex-direction: column; gap: 0.4rem; }
  .tools-label { font-size: 0.8rem; color: #64748b; font-weight: 500; }
  .tools-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .tool-presets { display: flex; gap: 0.25rem; }
  .preset-btn {
    background: #1e2130; border: 1px solid #2d3748; color: #64748b;
    padding: 0.2rem 0.5rem; font-size: 0.7rem; border-radius: 4px; cursor: pointer;
  }
  .preset-btn:hover:not(:disabled) { background: #252d3d; color: #94a3b8; }
  .tools-grid { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .tool-chip {
    display: flex; align-items: center; gap: 0.3rem; padding: 0.3rem 0.5rem;
    background: #1e2130; border: 1px solid #2d3748; border-radius: 5px;
    cursor: pointer; font-size: 0.75rem; transition: border-color 0.15s;
  }
  .tool-chip:hover { background: #252d3d; }
  .tool-chip.active { border-color: #6366f1; background: #1e1b4b; }
  .tool-chip input[type='checkbox'] { accent-color: #6366f1; margin: 0; width: 12px; height: 12px; }
  .tool-name { color: #cbd5e1; font-weight: 600; }
  .tool-desc { color: #475569; font-size: 0.65rem; }

  .error { color: #f87171; font-size: 0.85rem; margin: 0; }

  /* --- Status --- */
  .status-section { display: flex; flex-direction: column; gap: 0.75rem; }
  .workflow-header { display: flex; align-items: center; gap: 0.5rem; }
  .back-btn {
    background: none; border: 1px solid #2d3748; color: #94a3b8;
    padding: 0.2rem 0.5rem; font-size: 0.8rem; border-radius: 4px; cursor: pointer;
  }
  .back-btn:hover { background: #1e2130; color: #e2e8f0; }
  .wf-id { font-size: 0.75rem; color: #475569; font-family: monospace; }

  .phases { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .phase { display: flex; align-items: center; gap: 0.3rem; font-size: 0.75rem; opacity: 0.35; }
  .phase.done { opacity: 0.7; color: #6ee7b7; }
  .phase.active { opacity: 1; color: #818cf8; font-weight: 600; }
  .phase-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .phase.active .phase-dot { animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .progress-bar-wrap { background: #1e2130; border-radius: 99px; height: 5px; overflow: hidden; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, #6366f1, #818cf8); border-radius: 99px; transition: width 0.5s ease; }
  .progress-text { font-size: 0.8rem; color: #64748b; margin: 0; }
  .waiting { color: #475569; font-size: 0.85rem; }

  .live-tasks { display: flex; flex-direction: column; gap: 0.25rem; }
  .live-task {
    display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem;
    background: #1e2130; border-left: 3px solid #475569; border-radius: 0 6px 6px 0; font-size: 0.8rem;
  }
  .live-task-icon { width: 1rem; text-align: center; flex-shrink: 0; font-weight: 700; }
  .live-task-desc { flex: 1; color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-task-status { font-size: 0.65rem; color: #475569; text-transform: uppercase; }

  .event-log-section { margin-top: 0.25rem; }
  .event-log-section summary { font-size: 0.8rem; color: #64748b; cursor: pointer; font-weight: 500; }
  .event-log-section summary:hover { color: #94a3b8; }
  .event-log {
    background: #161822; border: 1px solid #1e2130; border-radius: 6px;
    max-height: 250px; overflow-y: auto; padding: 0.4rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.7rem; margin-top: 0.4rem;
  }
  .event-row { display: flex; align-items: baseline; gap: 0.4rem; padding: 0.15rem 0.3rem; border-radius: 3px; }
  .event-row:hover { background: #1e2130; }
  .event-time { color: #334155; flex-shrink: 0; }
  .event-icon { width: 0.8rem; text-align: center; flex-shrink: 0; }
  .event-summary { color: #94a3b8; word-break: break-word; }

  /* --- Result --- */
  .result-section { margin-top: 1.5rem; }
  h2 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.75rem; color: #f8fafc; }
  .final-response {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 8px; padding: 1rem;
    white-space: pre-wrap; word-break: break-word; font-family: inherit;
    font-size: 0.85rem; line-height: 1.6; color: #e2e8f0; margin: 0;
  }
  .stats { display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.8rem; color: #64748b; }
  .stats .passed { color: #6ee7b7; }
  .stats .failed { color: #f87171; }
  .review-notes { font-size: 0.8rem; color: #64748b; margin: 0.4rem 0 0; }

  .task-details { margin-top: 0.75rem; }
  .task-details summary { font-size: 0.85rem; color: #64748b; cursor: pointer; font-weight: 500; }
  .task-details summary:hover { color: #94a3b8; }
  .task-list { list-style: none; padding: 0; margin: 0.5rem 0 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .task-item { background: #1e2130; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; }
  .task-item.rejected { border-color: #7f1d1d; }
  .task-header {
    display: flex; align-items: center; gap: 0.6rem; width: 100%;
    background: none; border: none; border-radius: 0; padding: 0.6rem 0.8rem;
    color: #e2e8f0; font-size: 0.85rem; cursor: pointer; text-align: left;
  }
  .task-header:hover { background: #252d3d; }
  .task-icon { width: 1rem; text-align: center; flex-shrink: 0; color: #6ee7b7; }
  .task-item.rejected .task-icon { color: #f87171; }
  .task-desc { flex: 1; color: #cbd5e1; }
  .task-toggle { color: #334155; font-size: 0.65rem; flex-shrink: 0; }
  .task-body { padding: 0.6rem 0.8rem; border-top: 1px solid #2d3748; }
  .task-body pre {
    background: #0f1117; border-radius: 6px; padding: 0.6rem;
    white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; line-height: 1.5; margin: 0; color: #94a3b8;
  }
  .review-note { font-size: 0.75rem; color: #64748b; margin: 0.4rem 0 0; }
  .reset-btn {
    margin-top: 1rem; background: #1e2130; border: 1px solid #2d3748; color: #94a3b8;
    padding: 0.5rem 1.2rem; font-size: 0.85rem; border-radius: 6px; cursor: pointer;
  }
  .reset-btn:hover { background: #252d3d; }

  /* --- Mobile --- */
  @media (max-width: 768px) {
    .sidebar {
      position: fixed; left: 0; top: 0; z-index: 100;
      transform: translateX(-100%); transition: transform 0.2s ease;
      width: 280px;
    }
    .sidebar.open { transform: translateX(0); }
    .overlay { display: block; }
    .topbar {
      display: flex; align-items: center; gap: 0.75rem;
      margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid #1e2130;
    }
    main { padding: 1rem; }
  }
</style>
