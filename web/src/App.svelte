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

  const PHASES: Phase[] = [
    'planning',
    'validating',
    'executing',
    'integrating',
    'reviewing',
    'complete',
  ];

  const PHASE_LABELS: Record<string, string> = {
    planning: 'Planning',
    validating: 'Validating',
    executing: 'Executing',
    integrating: 'Integrating',
    reviewing: 'Reviewing',
    complete: 'Complete',
  };

  const AVAILABLE_TOOLS = [
    { id: 'Read', label: 'Read', desc: 'ファイル読み取り' },
    { id: 'Write', label: 'Write', desc: 'ファイル書き込み' },
    { id: 'Edit', label: 'Edit', desc: 'ファイル編集' },
    { id: 'Bash', label: 'Bash', desc: 'シェルコマンド実行' },
    { id: 'Glob', label: 'Glob', desc: 'ファイルパターン検索' },
    { id: 'Grep', label: 'Grep', desc: 'ファイル内容検索' },
    { id: 'WebFetch', label: 'WebFetch', desc: 'URL取得' },
    { id: 'WebSearch', label: 'WebSearch', desc: 'Web検索' },
    { id: 'NotebookEdit', label: 'NotebookEdit', desc: 'Jupyter編集' },
  ] as const;

  // --- State ---
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
  let showHistory = $state(false);
  let currentSse: EventSource | null = null;

  let eventLogEl: HTMLElement | undefined = $state();

  // --- URL hash persistence ---
  function syncHashToState() {
    const hash = location.hash.replace('#', '');
    if (hash && hash.startsWith('agentic-')) {
      openWorkflow(hash);
    }
  }

  function setHash(id: string | null) {
    if (id) {
      history.replaceState(null, '', `#${id}`);
    } else {
      history.replaceState(null, '', location.pathname);
    }
  }

  // --- History ---
  async function loadHistory() {
    try {
      const res = await fetch('/api/workflows');
      if (res.ok) {
        workflowHistory = (await res.json()) as HistoryEntry[];
      }
    } catch {
      // ignore
    }
  }

  // --- Open existing workflow ---
  async function openWorkflow(id: string) {
    if (currentSse) { currentSse.close(); currentSse = null; }

    workflowId = id;
    wfState = null;
    result = null;
    error = null;
    loading = true;
    setHash(id);

    try {
      // Check workflow status
      const detailRes = await fetch(`/api/workflow/${id}`);
      if (!detailRes.ok) {
        error = 'Workflow not found';
        loading = false;
        return;
      }
      const detail = (await detailRes.json()) as { status: string; phase: string };

      if (detail.status === 'COMPLETED') {
        // Fetch result directly
        await fetchResult(id);
      } else if (detail.status === 'RUNNING') {
        // Connect SSE
        connectSse(id);
      } else {
        // FAILED, CANCELLED, etc.
        error = `Workflow status: ${detail.status}`;
        loading = false;
      }
    } catch (e) {
      error = (e as Error).message;
      loading = false;
    }
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
          sse.close();
          currentSse = null;
          if (data.phase === 'complete') {
            fetchResult(id);
          } else {
            loading = false;
            error = 'Workflow failed';
          }
          loadHistory();
        }
      }
    };
    sse.onerror = () => {
      sse.close();
      currentSse = null;
      // Workflow may have completed before we connected — try fetching result
      fetchResult(id).catch(() => { loading = false; });
    };
  }

  // --- Tool helpers ---
  function toggleTool(id: string) {
    const next = new Set(enabledTools);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    enabledTools = next;
  }

  function setToolPreset(preset: 'none' | 'readonly' | 'all') {
    if (preset === 'none') enabledTools = new Set();
    else if (preset === 'readonly') enabledTools = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    else enabledTools = new Set(AVAILABLE_TOOLS.map((t) => t.id));
  }

  function phaseIndex(phase: Phase): number {
    return PHASES.indexOf(phase);
  }

  function scrollEventLog() {
    if (eventLogEl) eventLogEl.scrollTop = eventLogEl.scrollHeight;
  }

  // --- Submit new workflow ---
  async function submit() {
    if (!prompt.trim() || loading) return;
    loading = true;
    error = null;
    wfState = null;
    result = null;
    workflowId = null;

    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model,
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
    } catch (e) {
      error = (e as Error).message;
      loading = false;
    }
  }

  async function fetchResult(id: string) {
    try {
      const res = await fetch(`/api/result/${id}`);
      if (!res.ok) throw new Error(res.statusText);
      result = (await res.json()) as WorkflowResult;
      // Also build wfState from result for display
      if (!wfState) {
        wfState = {
          phase: 'complete',
          totalTasks: result.tasks.length,
          completedTasks: result.tasks.length,
          currentlyExecuting: [],
          events: [],
          tasks: result.tasks,
        };
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function toggleTask(id: string) {
    const next = new Set(expandedTasks);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    expandedTasks = next;
  }

  function statusIcon(status: TaskState['status']): string {
    switch (status) {
      case 'reviewed': return '✓';
      case 'rejected': return '✗';
      case 'executing': return '⟳';
      case 'executed': return '…';
      default: return '○';
    }
  }

  function statusColor(status: TaskState['status']): string {
    switch (status) {
      case 'reviewed': return '#6ee7b7';
      case 'rejected': return '#f87171';
      case 'executing': return '#818cf8';
      case 'executed': return '#fbbf24';
      default: return '#475569';
    }
  }

  function eventIcon(kind: string): string {
    if (kind.endsWith('_start')) return '▶';
    if (kind.endsWith('_done')) return '✓';
    return '·';
  }

  function eventColor(kind: string): string {
    if (kind.startsWith('planner')) return '#a78bfa';
    if (kind.startsWith('validator')) return '#67e8f9';
    if (kind.startsWith('executor')) return '#818cf8';
    if (kind.startsWith('reviewer')) return '#fbbf24';
    if (kind.startsWith('integrator')) return '#34d399';
    if (kind.startsWith('integration_reviewer')) return '#6ee7b7';
    return '#94a3b8';
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString('ja-JP', { hour12: false });
  }

  function formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status: string): { label: string; color: string } {
    switch (status) {
      case 'RUNNING': return { label: '実行中', color: '#818cf8' };
      case 'COMPLETED': return { label: '完了', color: '#6ee7b7' };
      case 'FAILED': return { label: '失敗', color: '#f87171' };
      case 'CANCELLED': return { label: '中止', color: '#94a3b8' };
      case 'TERMINATED': return { label: '終了', color: '#94a3b8' };
      default: return { label: status, color: '#64748b' };
    }
  }

  function goHome() {
    if (currentSse) { currentSse.close(); currentSse = null; }
    workflowId = null;
    wfState = null;
    result = null;
    error = null;
    loading = false;
    expandedTasks = new Set();
    setHash(null);
  }

  onMount(() => {
    loadHistory();
    syncHashToState();
    window.addEventListener('hashchange', syncHashToState);
    return () => window.removeEventListener('hashchange', syncHashToState);
  });
</script>

<main>
  <header>
    <div class="header-row">
      <div>
        <h1 onclick={goHome} class="clickable">Agentic Workflow</h1>
        <p>Temporal.io + Claude — マルチエージェントパイプライン</p>
      </div>
      <button class="history-toggle" onclick={() => { showHistory = !showHistory; if (showHistory) loadHistory(); }}>
        {showHistory ? '履歴を閉じる' : '履歴'}
        {#if workflowHistory.length > 0}
          <span class="badge">{workflowHistory.length}</span>
        {/if}
      </button>
    </div>
  </header>

  <!-- History panel -->
  {#if showHistory}
    <section class="history-panel">
      <h3>ワークフロー履歴</h3>
      {#if workflowHistory.length === 0}
        <p class="history-empty">履歴がありません</p>
      {:else}
        <ul class="history-list">
          {#each workflowHistory as entry}
            {@const badge = statusBadge(entry.status)}
            <li class:active={workflowId === entry.workflowId}>
              <button class="history-item" onclick={() => { openWorkflow(entry.workflowId); showHistory = false; }}>
                <span class="history-badge" style="color: {badge.color}">{badge.label}</span>
                <span class="history-prompt">{entry.prompt ?? entry.workflowId.replace('agentic-', '').slice(0, 8)}</span>
                <span class="history-time">{formatDateTime(entry.startTime)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if !workflowId}
    <section class="input-section">
      <label for="prompt">プロンプト</label>
      <textarea
        id="prompt"
        bind:value={prompt}
        rows={5}
        placeholder="例: TypeScript で RESTful API を設計してください"
        disabled={loading}
      ></textarea>

      <div class="options">
        <label for="model">モデル</label>
        <select id="model" bind:value={model} disabled={loading}>
          <option value="claude-opus-4-6">claude-opus-4-6</option>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
        </select>
      </div>

      <div class="tools-section">
        <div class="tools-header">
          <span class="tools-label">Executor に許可するツール</span>
          <div class="tool-presets">
            <button class="preset-btn" onclick={() => setToolPreset('none')} disabled={loading}>なし</button>
            <button class="preset-btn" onclick={() => setToolPreset('readonly')} disabled={loading}>読み取り専用</button>
            <button class="preset-btn" onclick={() => setToolPreset('all')} disabled={loading}>すべて</button>
          </div>
        </div>
        <div class="tools-grid">
          {#each AVAILABLE_TOOLS as tool}
            <label class="tool-chip" class:active={enabledTools.has(tool.id)}>
              <input
                type="checkbox"
                checked={enabledTools.has(tool.id)}
                onchange={() => toggleTool(tool.id)}
                disabled={loading}
              />
              <span class="tool-name">{tool.label}</span>
              <span class="tool-desc">{tool.desc}</span>
            </label>
          {/each}
        </div>
      </div>

      <button onclick={submit} disabled={!prompt.trim() || loading}>
        {loading ? '実行中…' : '実行'}
      </button>

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </section>
  {:else}
    <section class="status-section">
      <div class="status-header">
        <div class="workflow-id">
          <button class="back-btn" onclick={goHome}>← 戻る</button>
          <code>{workflowId}</code>
        </div>
      </div>

      {#if wfState}
        <div class="phases">
          {#each PHASES as phase}
            {@const idx = phaseIndex(phase)}
            {@const cur = phaseIndex(wfState.phase)}
            <div class="phase" class:done={idx < cur} class:active={idx === cur} class:pending={idx > cur}>
              <span class="phase-dot"></span>
              <span class="phase-label">{PHASE_LABELS[phase] ?? phase}</span>
            </div>
          {/each}
        </div>

        {#if wfState.totalTasks > 0}
          <div class="progress-bar-wrap">
            <div class="progress-bar" style="width: {(wfState.completedTasks / wfState.totalTasks) * 100}%"></div>
          </div>
          <p class="progress-text">
            {wfState.completedTasks} / {wfState.totalTasks} tasks
            {#if wfState.currentlyExecuting.length > 0}
              — {wfState.currentlyExecuting.length} 並列実行中
            {/if}
          </p>
        {/if}

        {#if wfState.tasks.length > 0}
          <div class="live-tasks">
            <h3>タスク</h3>
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
          <div class="event-log-section">
            <h3>アクティビティログ</h3>
            <div class="event-log" bind:this={eventLogEl}>
              {#each wfState.events as event}
                <div class="event-row">
                  <span class="event-time">{formatTime(event.timestamp)}</span>
                  <span class="event-icon" style="color: {eventColor(event.kind)}">{eventIcon(event.kind)}</span>
                  <span class="event-summary">{event.summary}</span>
                </div>
              {/each}
            </div>
          </div>
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
          <span>実行時間: {(result.executionTimeMs / 1000).toFixed(1)}s</span>
          <span>タスク: {result.tasks.filter((t) => t.reviewPassed).length}/{result.tasks.length} passed</span>
          <span class:passed={result.integrationReviewPassed} class:failed={!result.integrationReviewPassed}>
            統合レビュー: {result.integrationReviewPassed ? '✓ passed' : '✗ failed'}
          </span>
        </div>

        {#if result.integrationReviewNotes}
          <p class="review-notes">{result.integrationReviewNotes}</p>
        {/if}

        <h3>タスク詳細</h3>
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

        <button class="reset-btn" onclick={goHome}>新しいタスクを実行</button>
      </section>
    {/if}
  {/if}
</main>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; }
  :global(body) { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; }

  main { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }

  header { margin-bottom: 1.5rem; }
  .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.75rem; font-weight: 700; margin: 0 0 0.25rem; color: #f8fafc; }
  h1.clickable { cursor: pointer; }
  h1.clickable:hover { color: #818cf8; }
  header p { color: #94a3b8; margin: 0; font-size: 0.9rem; }

  .history-toggle {
    background: #1e2130; border: 1px solid #2d3748; color: #94a3b8;
    padding: 0.4rem 0.8rem; font-size: 0.8rem; border-radius: 6px;
    cursor: pointer; display: flex; align-items: center; gap: 0.4rem; white-space: nowrap;
  }
  .history-toggle:hover { background: #252d3d; color: #e2e8f0; }
  .badge {
    background: #6366f1; color: white; font-size: 0.65rem; font-weight: 700;
    padding: 0.1rem 0.4rem; border-radius: 99px; min-width: 1.2rem; text-align: center;
  }

  /* History panel */
  .history-panel {
    background: #161822; border: 1px solid #2d3748; border-radius: 8px;
    padding: 0.75rem; margin-bottom: 1.5rem;
  }
  .history-panel h3 { font-size: 0.85rem; font-weight: 600; margin: 0 0 0.5rem; color: #cbd5e1; }
  .history-empty { font-size: 0.8rem; color: #64748b; margin: 0; }
  .history-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; max-height: 300px; overflow-y: auto; }
  .history-list li.active .history-item { background: #1e1b4b; border-color: #6366f1; }
  .history-item {
    display: flex; align-items: center; gap: 0.6rem; width: 100%;
    background: #1e2130; border: 1px solid transparent; border-radius: 6px;
    padding: 0.5rem 0.75rem; color: #e2e8f0; font-size: 0.8rem;
    cursor: pointer; text-align: left;
  }
  .history-item:hover { background: #252d3d; }
  .history-badge { font-size: 0.7rem; font-weight: 600; flex-shrink: 0; min-width: 3rem; }
  .history-prompt { color: #cbd5e1; font-size: 0.8rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .history-time { color: #64748b; font-size: 0.7rem; margin-left: auto; flex-shrink: 0; }

  /* Input section */
  .input-section { display: flex; flex-direction: column; gap: 0.75rem; }
  label { font-size: 0.875rem; color: #94a3b8; font-weight: 500; }
  textarea {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 8px;
    color: #e2e8f0; font-size: 0.95rem; padding: 0.75rem;
    resize: vertical; outline: none; transition: border-color 0.15s; font-family: inherit;
  }
  textarea:focus { border-color: #6366f1; }
  .options { display: flex; align-items: center; gap: 0.75rem; }
  select {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 6px;
    color: #e2e8f0; padding: 0.4rem 0.75rem; font-size: 0.875rem; outline: none;
  }

  .tools-section { display: flex; flex-direction: column; gap: 0.5rem; }
  .tools-label { font-size: 0.875rem; color: #94a3b8; font-weight: 500; }
  .tools-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; }
  .tool-presets { display: flex; gap: 0.35rem; }
  .preset-btn {
    background: #1e2130; border: 1px solid #2d3748; color: #94a3b8;
    padding: 0.25rem 0.6rem; font-size: 0.75rem; border-radius: 4px; cursor: pointer; font-weight: 500;
  }
  .preset-btn:hover:not(:disabled) { background: #252d3d; color: #e2e8f0; }
  .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.35rem; }
  .tool-chip {
    display: flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.6rem;
    background: #1e2130; border: 1px solid #2d3748; border-radius: 6px;
    cursor: pointer; transition: border-color 0.15s, background 0.15s; font-size: 0.8rem;
  }
  .tool-chip:hover { background: #252d3d; }
  .tool-chip.active { border-color: #6366f1; background: #1e1b4b; }
  .tool-chip input[type='checkbox'] { accent-color: #6366f1; margin: 0; width: 14px; height: 14px; }
  .tool-name { color: #e2e8f0; font-weight: 600; font-size: 0.8rem; }
  .tool-desc { color: #64748b; font-size: 0.7rem; }

  button {
    background: #6366f1; color: white; border: none; border-radius: 8px;
    padding: 0.65rem 1.5rem; font-size: 0.95rem; font-weight: 600;
    cursor: pointer; transition: background 0.15s; align-self: flex-start;
  }
  button:hover:not(:disabled) { background: #4f46e5; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .error { color: #f87171; font-size: 0.875rem; margin: 0; }

  /* Status section */
  .status-section { display: flex; flex-direction: column; gap: 1rem; }
  .status-header { display: flex; align-items: center; gap: 0.5rem; }
  .workflow-id { font-size: 0.8rem; color: #64748b; display: flex; align-items: center; gap: 0.5rem; }
  .workflow-id code { color: #94a3b8; font-family: monospace; }
  .back-btn {
    background: none; border: 1px solid #2d3748; color: #94a3b8;
    padding: 0.25rem 0.5rem; font-size: 0.75rem; border-radius: 4px; cursor: pointer;
  }
  .back-btn:hover { background: #1e2130; color: #e2e8f0; }

  .phases { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .phase { display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; opacity: 0.4; }
  .phase.done { opacity: 0.7; color: #6ee7b7; }
  .phase.active { opacity: 1; color: #818cf8; font-weight: 600; }
  .phase-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .phase.active .phase-dot { animation: pulse 1.2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .progress-bar-wrap { background: #1e2130; border-radius: 99px; height: 6px; overflow: hidden; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, #6366f1, #818cf8); border-radius: 99px; transition: width 0.5s ease; }
  .progress-text { font-size: 0.85rem; color: #94a3b8; margin: 0; }
  .waiting { color: #64748b; font-size: 0.9rem; }

  .live-tasks { margin-top: 0.5rem; }
  h3 { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; color: #cbd5e1; }
  .live-task {
    display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.75rem;
    background: #1e2130; border-left: 3px solid #475569; border-radius: 0 6px 6px 0;
    margin-bottom: 0.35rem; font-size: 0.85rem;
  }
  .live-task-icon { width: 1rem; text-align: center; flex-shrink: 0; font-weight: 700; }
  .live-task-desc { flex: 1; color: #cbd5e1; }
  .live-task-status { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.03em; }

  .event-log-section { margin-top: 0.5rem; }
  .event-log {
    background: #161822; border: 1px solid #2d3748; border-radius: 8px;
    max-height: 300px; overflow-y: auto; padding: 0.5rem;
    font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8rem;
  }
  .event-row { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.2rem 0.4rem; border-radius: 4px; }
  .event-row:hover { background: #1e2130; }
  .event-time { color: #475569; flex-shrink: 0; font-size: 0.75rem; }
  .event-icon { width: 1rem; text-align: center; flex-shrink: 0; }
  .event-summary { color: #94a3b8; word-break: break-word; }

  .result-section { margin-top: 2rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; color: #f8fafc; }
  .final-response {
    background: #1e2130; border: 1px solid #2d3748; border-radius: 8px; padding: 1rem;
    white-space: pre-wrap; word-break: break-word; font-family: inherit;
    font-size: 0.9rem; line-height: 1.6; color: #e2e8f0;
  }
  .stats { display: flex; gap: 1.25rem; flex-wrap: wrap; margin-top: 0.75rem; font-size: 0.85rem; color: #94a3b8; }
  .stats .passed { color: #6ee7b7; }
  .stats .failed { color: #f87171; }
  .review-notes { font-size: 0.85rem; color: #94a3b8; margin: 0.5rem 0 0; }

  .task-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .task-item { background: #1e2130; border: 1px solid #2d3748; border-radius: 8px; overflow: hidden; }
  .task-item.rejected { border-color: #7f1d1d; }
  .task-header {
    display: flex; align-items: center; gap: 0.75rem; width: 100%;
    background: none; border: none; border-radius: 0; padding: 0.75rem 1rem;
    color: #e2e8f0; font-size: 0.9rem; cursor: pointer; text-align: left;
  }
  .task-header:hover { background: #252d3d; }
  .task-icon { font-size: 0.85rem; width: 1.2rem; text-align: center; flex-shrink: 0; color: #6ee7b7; }
  .task-item.rejected .task-icon { color: #f87171; }
  .task-desc { flex: 1; color: #cbd5e1; }
  .task-toggle { color: #475569; font-size: 0.7rem; flex-shrink: 0; }
  .task-body { padding: 0.75rem 1rem; border-top: 1px solid #2d3748; }
  .task-body pre {
    background: #0f1117; border-radius: 6px; padding: 0.75rem;
    white-space: pre-wrap; word-break: break-word; font-size: 0.825rem; line-height: 1.5; margin: 0; color: #94a3b8;
  }
  .review-note { font-size: 0.825rem; color: #94a3b8; margin: 0.5rem 0 0; }
  .reset-btn { margin-top: 1.5rem; background: #1e2130; border: 1px solid #2d3748; color: #94a3b8; }
  .reset-btn:hover:not(:disabled) { background: #252d3d; }
</style>
