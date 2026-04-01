<script lang="ts">
  import { onMount } from 'svelte';
  import { marked } from 'marked';

  // Configure marked for safe rendering
  marked.setOptions({ breaks: true, gfm: true });

  function md(text: string): string {
    return marked.parse(text, { async: false }) as string;
  }

  type Phase = 'planning' | 'validating' | 'executing' | 'integrating' | 'reviewing' | 'complete' | 'failed';

  interface ActivityEvent { kind: string; timestamp: number; taskId?: string; taskDescription?: string; summary: string; }
  interface TaskState { id: string; description: string; dependsOn: string[]; status: 'pending' | 'executing' | 'executed' | 'reviewed' | 'rejected'; result?: string; reviewNotes?: string; reviewPassed: boolean; }
  interface WorkflowState { phase: Phase; totalTasks: number; completedTasks: number; currentlyExecuting: string[]; events: ActivityEvent[]; tasks: TaskState[]; }
  interface ReviewScore { completeness: number; accuracy: number; structure: number; actionability: number; overall: number; }
  interface WorkflowResult { finalResponse: string; integrationReviewPassed: boolean; integrationReviewNotes: string; score?: ReviewScore; strengths?: string[]; improvements?: string[]; tasks: TaskState[]; executionTimeMs: number; pipelineAttempt?: number; }
  interface HistoryEntry { workflowId: string; status: string; startTime: string; prompt?: string; }

  const PHASES: Phase[] = ['planning', 'validating', 'executing', 'integrating', 'reviewing', 'complete'];
  const PHASE_META: Record<string, { icon: string; label: string; color: string }> = {
    planning:    { icon: '🧠', label: 'Planner',    color: 'var(--purple)' },
    validating:  { icon: '🔍', label: 'Validator',   color: 'var(--cyan)' },
    executing:   { icon: '⚡', label: 'Executor',    color: 'var(--blue)' },
    integrating: { icon: '🔗', label: 'Integrator',  color: 'var(--green)' },
    reviewing:   { icon: '✅', label: 'Reviewer',    color: 'var(--teal)' },
    complete:    { icon: '🏁', label: 'Complete',    color: 'var(--green)' },
  };

  const AVAILABLE_TOOLS = [
    { id: 'Read', label: 'Read', desc: 'ファイル読み取り', icon: '📄' },
    { id: 'Write', label: 'Write', desc: 'ファイル書き込み', icon: '✏️' },
    { id: 'Edit', label: 'Edit', desc: 'ファイル編集', icon: '📝' },
    { id: 'Bash', label: 'Bash', desc: 'シェルコマンド', icon: '💻' },
    { id: 'Glob', label: 'Glob', desc: 'パターン検索', icon: '🔍' },
    { id: 'Grep', label: 'Grep', desc: '内容検索', icon: '🔎' },
    { id: 'WebFetch', label: 'WebFetch', desc: 'URL取得', icon: '🌐' },
    { id: 'WebSearch', label: 'WebSearch', desc: 'Web検索', icon: '🔗' },
    { id: 'NotebookEdit', label: 'Notebook', desc: 'Jupyter', icon: '📓' },
    { id: 'Task', label: 'Task', desc: 'サブタスク', icon: '📋' },
    { id: 'ToolSearch', label: 'ToolSearch', desc: 'ツール検索', icon: '🧰' },
  ] as const;

  let prompt = $state('');
  let model = $state('claude-opus-4-6');
  let maxRetries = $state(0);
  let maxTaskRetries = $state(0);
  let enabledTools = $state<Set<string>>(new Set());
  let workflowId = $state<string | null>(null);
  let workflowPrompt = $state<string | null>(null);
  let wfState = $state<WorkflowState | null>(null);
  let result = $state<WorkflowResult | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let expandedTasks = $state<Set<string>>(new Set());
  let workflowHistory = $state<HistoryEntry[]>([]);
  let sidebarOpen = $state(false);
  let currentSse: EventSource | null = null;
  let eventLogEl: HTMLElement | undefined = $state();

  // --- Core logic (unchanged) ---
  function syncHashToState() { const h = location.hash.replace('#',''); if (h?.startsWith('agentic-')) openWorkflow(h); }
  function setHash(id: string | null) { if (id) history.replaceState(null,'',`#${id}`); else history.replaceState(null,'',location.pathname); }
  async function loadHistory() { try { const r = await fetch('/api/workflows'); if (r.ok) workflowHistory = await r.json(); } catch {} }
  async function openWorkflow(id: string) {
    if (currentSse) { currentSse.close(); currentSse = null; }
    workflowId = id; wfState = null; result = null; error = null; loading = true; expandedTasks = new Set(); setHash(id); sidebarOpen = false;
    workflowPrompt = workflowHistory.find((w) => w.workflowId === id)?.prompt ?? null;
    try {
      const r = await fetch(`/api/workflow/${id}`); if (!r.ok) { error = 'Workflow not found'; loading = false; return; }
      const d = await r.json(); if (d.status === 'COMPLETED') await fetchResult(id); else if (d.status === 'RUNNING') connectSse(id); else { error = `Status: ${d.status}`; loading = false; }
    } catch (e) { error = (e as Error).message; loading = false; }
  }
  function connectSse(id: string) {
    const sse = new EventSource(`/api/status/${id}`); currentSse = sse;
    sse.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type==='status') { wfState = d; requestAnimationFrame(scrollEventLog); if (d.phase==='complete'||d.phase==='failed') { sse.close(); currentSse=null; if (d.phase==='complete') fetchResult(id); else { loading=false; error='Workflow failed'; } loadHistory(); } } };
    sse.onerror = () => { sse.close(); currentSse=null; fetchResult(id).catch(()=>{loading=false;}); };
  }
  function toggleTool(id: string) { const n=new Set(enabledTools); if(n.has(id))n.delete(id);else n.add(id); enabledTools=n; }
  function setToolPreset(p: 'none'|'readonly'|'all') { if(p==='none')enabledTools=new Set();else if(p==='readonly')enabledTools=new Set(['Read','Glob','Grep','WebFetch','WebSearch']);else enabledTools=new Set(AVAILABLE_TOOLS.map(t=>t.id)); }
  function phaseIndex(p: Phase) { return PHASES.indexOf(p); }
  function scrollEventLog() { if(eventLogEl)eventLogEl.scrollTop=eventLogEl.scrollHeight; }
  async function submit() {
    if(!prompt.trim()||loading)return; loading=true;error=null;wfState=null;result=null;workflowId=null;workflowPrompt=prompt.trim();
    try { const r=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt.trim(),model,allowedTools:enabledTools.size>0?[...enabledTools]:undefined,maxPipelineRetries:maxRetries||undefined,maxTaskRetries:maxTaskRetries||undefined})}); if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error((b as any).error??r.statusText);} const{workflowId:id}=await r.json();workflowId=id;setHash(id);connectSse(id);loadHistory(); } catch(e){error=(e as Error).message;loading=false;}
  }
  async function fetchResult(id: string) {
    try { const r=await fetch(`/api/result/${id}`);if(!r.ok)throw new Error(r.statusText);result=await r.json();if(!wfState)wfState={phase:'complete',totalTasks:result!.tasks.length,completedTasks:result!.tasks.length,currentlyExecuting:[],events:[],tasks:result!.tasks}; } catch(e){error=(e as Error).message;} finally{loading=false;}
  }
  function toggleTask(id: string) { const n=new Set(expandedTasks);if(n.has(id))n.delete(id);else n.add(id);expandedTasks=n; }

  // --- Helpers ---
  function statusIcon(s: TaskState['status']) { return s==='reviewed'?'✓':s==='rejected'?'✗':s==='executing'?'⟳':s==='executed'?'…':'○'; }
  function statusColor(s: TaskState['status']) { return s==='reviewed'?'var(--green)':s==='rejected'?'var(--red)':s==='executing'?'var(--blue)':s==='executed'?'var(--amber)':'var(--muted)'; }
  function eventIcon(k: string) { return k.endsWith('_start')?'▶':k.endsWith('_done')?'✓':'·'; }
  function eventColor(k: string) { if(k.startsWith('planner'))return'var(--purple)';if(k.startsWith('validator'))return'var(--cyan)';if(k.startsWith('executor'))return'var(--blue)';if(k.startsWith('reviewer'))return'var(--amber)';if(k.startsWith('integrator'))return'var(--green)';if(k.startsWith('integration_reviewer'))return'var(--teal)';return'var(--muted)'; }
  function formatTime(ts: number) { return new Date(ts).toLocaleTimeString('ja-JP',{hour12:false}); }
  function formatDateTime(iso: string) { const d=new Date(iso);return d.toLocaleDateString('ja-JP',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('ja-JP',{hour12:false,hour:'2-digit',minute:'2-digit'}); }
  function statusBadge(s: string) { return s==='RUNNING'?{l:'実行中',c:'var(--blue)'}:s==='COMPLETED'?{l:'完了',c:'var(--green)'}:s==='FAILED'?{l:'失敗',c:'var(--red)'}:{l:s,c:'var(--muted)'}; }
  let copied = $state(false);

  function getFullReportMarkdown(): string {
    if (!result) return '';
    const wfId = workflowId?.replace('agentic-', '').slice(0, 8) ?? '';
    const lines: string[] = [];

    lines.push(`# Agentic Workflow Report`);
    if (workflowPrompt) lines.push(`\n## プロンプト\n\n${workflowPrompt}`);
    lines.push(`\n---\n`);

    // Each task result
    lines.push(`## タスク別成果物\n`);
    for (let i = 0; i < result.tasks.length; i++) {
      const t = result.tasks[i];
      const status = t.reviewPassed ? '✅' : '❌';
      lines.push(`### ${status} タスク ${i + 1}: ${t.description}\n`);
      if (t.result) lines.push(t.result);
      if (t.reviewNotes) lines.push(`\n> **レビュー:** ${t.reviewNotes}`);
      lines.push(`\n---\n`);
    }

    // Integrated response
    lines.push(`## 統合結果\n`);
    lines.push(result.finalResponse);

    // Review notes
    if (result.integrationReviewNotes) {
      lines.push(`\n---\n\n## 統合レビュー\n`);
      lines.push(`**結果:** ${result.integrationReviewPassed ? 'PASS ✅' : 'FAIL ❌'}\n`);
      lines.push(result.integrationReviewNotes);
    }

    // Stats
    lines.push(`\n---\n\n## メタデータ\n`);
    lines.push(`- 実行時間: ${(result.executionTimeMs / 1000).toFixed(1)}s`);
    lines.push(`- タスク: ${result.tasks.filter(t => t.reviewPassed).length}/${result.tasks.length} passed`);
    if (result.pipelineAttempt > 1) lines.push(`- 試行回数: ${result.pipelineAttempt}`);

    return lines.join('\n');
  }

  async function copyResult() {
    await navigator.clipboard.writeText(getFullReportMarkdown());
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  function downloadBlobAs(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadFullReport() {
    downloadBlobAs(getFullReportMarkdown(), `${workflowId?.replace('agentic-', '').slice(0, 8) ?? 'report'}-full.md`);
  }

  function downloadIntegrated() {
    if (!result) return;
    downloadBlobAs(result.finalResponse, `${workflowId?.replace('agentic-', '').slice(0, 8) ?? 'result'}.md`);
  }

  function goHome() { if(currentSse){currentSse.close();currentSse=null;} workflowId=null;wfState=null;result=null;error=null;workflowPrompt=null;loading=false;expandedTasks=new Set();setHash(null); }
  function passRate() { if(!result)return 0; return result.tasks.length>0?Math.round(result.tasks.filter(t=>t.reviewPassed).length/result.tasks.length*100):0; }

  onMount(()=>{loadHistory();syncHashToState();window.addEventListener('hashchange',syncHashToState);return()=>window.removeEventListener('hashchange',syncHashToState);});
</script>

{#if sidebarOpen}
  <button class="overlay" onclick={()=>sidebarOpen=false} aria-label="Close"></button>
{/if}

<div class="layout">
  <aside class="sidebar" class:open={sidebarOpen}>
    <div class="sidebar-header">
      <button class="logo" onclick={()=>{goHome();sidebarOpen=false;}}>
        <span class="logo-icon">A</span>
        <span class="logo-text">Agentic</span>
      </button>
      <button class="new-btn" onclick={()=>{goHome();sidebarOpen=false;}}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        新規
      </button>
    </div>
    <div class="history-list">
      {#each workflowHistory as entry}
        {@const b = statusBadge(entry.status)}
        <button class="history-item" class:active={workflowId===entry.workflowId} onclick={()=>openWorkflow(entry.workflowId)}>
          <div class="history-indicator" style="background:{b.c}"></div>
          <div class="history-content">
            <div class="history-prompt">{entry.prompt ?? entry.workflowId.slice(-8)}</div>
            <div class="history-meta"><span style="color:{b.c}">{b.l}</span><span>{formatDateTime(entry.startTime)}</span></div>
          </div>
        </button>
      {/each}
      {#if workflowHistory.length===0}
        <div class="history-empty">
          <p>まだワークフローがありません</p>
          <p class="sub">新規タスクを作成して開始しましょう</p>
        </div>
      {/if}
    </div>
  </aside>

  <main>
    <div class="topbar">
      <button class="hamburger" onclick={()=>{sidebarOpen=!sidebarOpen;if(sidebarOpen)loadHistory();}} aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
      <span class="topbar-title" onclick={goHome}>Agentic</span>
    </div>

    {#if !workflowId}
      <!-- HOME -->
      <div class="home fade-in">
        <div class="hero">
          <h1>Agentic Workflow</h1>
          <p class="hero-sub">Temporal.io + Claude によるマルチエージェントパイプライン</p>
        </div>

        <div class="card input-card">
          <textarea bind:value={prompt} rows={4} placeholder="タスクを入力してください..." disabled={loading}></textarea>
          <div class="input-footer">
            <div class="input-options">
              <select bind:value={model} disabled={loading}>
                <option value="claude-opus-4-6">Opus 4.6</option>
                <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
              </select>
              <div class="retry-input">
                <label for="retries">全体リトライ</label>
                <select id="retries" bind:value={maxRetries} disabled={loading}>
                  <option value={0}>なし</option>
                  <option value={1}>1回</option>
                  <option value={2}>2回</option>
                  <option value={3}>3回</option>
                </select>
              </div>
              <div class="retry-input">
                <label for="task-retries">タスクリトライ</label>
                <select id="task-retries" bind:value={maxTaskRetries} disabled={loading}>
                  <option value={0}>なし</option>
                  <option value={1}>1回</option>
                  <option value={2}>2回</option>
                  <option value={3}>3回</option>
                </select>
              </div>
            </div>
            <button class="run-btn" onclick={submit} disabled={!prompt.trim()||loading}>
              {#if loading}<span class="spinner"></span>{:else}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2l10 6-10 6V2z" fill="currentColor"/></svg>
              {/if}
              {loading?'実行中...':'実行'}
            </button>
          </div>
        </div>

        <div class="card tools-card">
          <div class="card-header">
            <span class="card-title">ツール権限</span>
            <div class="tool-presets">
              <button class="pill" class:active={enabledTools.size===0} onclick={()=>setToolPreset('none')}>なし</button>
              <button class="pill" class:active={enabledTools.size===5&&enabledTools.has('Read')} onclick={()=>setToolPreset('readonly')}>読取</button>
              <button class="pill" class:active={enabledTools.size===AVAILABLE_TOOLS.length} onclick={()=>setToolPreset('all')}>全て</button>
            </div>
          </div>
          <div class="tools-grid">
            {#each AVAILABLE_TOOLS as tool}
              <button class="tool-chip" class:active={enabledTools.has(tool.id)} onclick={()=>toggleTool(tool.id)} disabled={loading}>
                <span class="tool-icon">{tool.icon}</span>
                <span class="tool-label">{tool.label}</span>
              </button>
            {/each}
          </div>
        </div>

        {#if error}<div class="card error-card">{error}</div>{/if}
      </div>
    {:else}
      <!-- WORKFLOW VIEW -->
      <div class="workflow-view fade-in">
        <div class="workflow-nav">
          <button class="back-btn" onclick={goHome}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <code class="wf-id">{workflowId?.replace('agentic-','').slice(0,8)}</code>
          {#if wfState}
            <span class="phase-badge" class:running={wfState.phase!=='complete'&&wfState.phase!=='failed'} class:done={wfState.phase==='complete'} class:err={wfState.phase==='failed'}>
              {wfState.phase}
            </span>
          {/if}
        </div>

        {#if workflowPrompt}
          <details class="prompt-display" open>
            <summary class="prompt-summary">プロンプト</summary>
            <div class="prompt-display-text">{workflowPrompt}</div>
          </details>
        {/if}

        {#if wfState}
          <!-- 2-column grid: left=pipeline+metrics, right=tasks+log -->
          {@const cur = phaseIndex(wfState.phase)}
          {@const taskCount = Math.max(wfState.tasks.length, wfState.totalTasks, 1)}
          <div class="wf-grid">
          <div class="wf-left">
          <div class="dag">
            <!-- Row 1: Planner → Validator -->
            <div class="dag-row">
              <div class="pipe-node" class:done={cur>0} class:active={cur===0} style="--node-color:{PHASE_META.planning.color}">
                <div class="pipe-icon">{PHASE_META.planning.icon}</div>
                <div class="pipe-label">{PHASE_META.planning.label}</div>
                {#if cur===0}<div class="pipe-glow"></div>{/if}
              </div>
              <div class="pipe-connector" class:done={cur>=1} class:flowing={cur===0}>
                <div class="pipe-line-bg"></div>
                {#if cur>=1}<div class="pipe-line-fill"></div>{/if}
                {#if cur===0}<div class="particle p1"></div><div class="particle p2"></div><div class="particle p3"></div>{/if}
              </div>
              <div class="pipe-node" class:done={cur>1} class:active={cur===1} style="--node-color:{PHASE_META.validating.color}">
                <div class="pipe-icon">{PHASE_META.validating.icon}</div>
                <div class="pipe-label">{PHASE_META.validating.label}</div>
                {#if cur===1}<div class="pipe-glow"></div>{/if}
              </div>
            </div>

            <!-- Vertical connector: Validator → Parallel zone -->
            <div class="v-connector" class:done={cur>=2} class:flowing={cur===1}>
              <div class="v-line-bg"></div>
              {#if cur>=2}<div class="v-line-fill"></div>{/if}
              {#if cur===1}
                <div class="v-particle vp1"></div>
                <div class="v-particle vp2"></div>
              {/if}
              <div class="v-arrow" class:done={cur>=2}>▼</div>
            </div>

            <!-- Row 2: Executor×N → Reviewer×N (parallel lanes) -->
            <div class="dag-parallel">
              {#each wfState.tasks.length > 0 ? wfState.tasks : Array(taskCount).fill(null).map((_, i) => ({ id: `pending-${i}`, description: `Task ${i+1}`, status: 'pending' as const, dependsOn: [], reviewPassed: false })) as task, ti}
                {@const isExecuting = task.status === 'executing'}
                {@const isExecuted = task.status === 'executed' || task.status === 'reviewed' || task.status === 'rejected'}
                {@const isReviewing = task.status === 'executed'}
                {@const isReviewed = task.status === 'reviewed' || task.status === 'rejected'}
                {@const isRejected = task.status === 'rejected'}
                {@const retryCount = wfState.events.filter(e => e.kind === 'task_retry' && e.taskId === task.id).length}
                {@const isRetrying = isExecuting && retryCount > 0}
                {@const execColor = isRejected ? 'var(--red)' : isRetrying ? 'var(--amber)' : 'var(--blue)'}
                {@const reviewColor = isRejected ? 'var(--red)' : 'var(--amber)'}
                <div class="dag-lane" class:retrying={isRetrying}>
                  <div class="pipe-node small" class:done={isExecuted && !isRejected} class:active={isExecuting} class:rejected={isRejected} style="--node-color:{execColor}">
                    <div class="pipe-icon">{isRejected ? '⚠' : isRetrying ? '🔄' : '⚡'}</div>
                    <div class="pipe-label">Exec {ti+1}</div>
                    {#if isExecuting}<div class="pipe-glow"></div>{/if}
                  </div>
                  {#if retryCount > 0}
                    <div class="retry-badge">retry {retryCount}</div>
                  {/if}
                  <div class="pipe-connector short" class:done={isExecuted||isReviewed} class:rejected={isRejected} class:flowing={isExecuting}>
                    <div class="pipe-line-bg"></div>
                    {#if isExecuted||isReviewed}<div class="pipe-line-fill" class:red={isRejected}></div>{/if}
                    {#if isExecuting}<div class="particle p1"></div><div class="particle p2"></div>{/if}
                  </div>
                  <div class="pipe-node small" class:done={isReviewed && !isRejected} class:active={isReviewing} class:rejected={isRejected} style="--node-color:{reviewColor}">
                    <div class="pipe-icon">{isRejected?'✗':isReviewed?'✓':'📋'}</div>
                    <div class="pipe-label">Review</div>
                    {#if isReviewing}<div class="pipe-glow"></div>{/if}
                  </div>
                </div>
              {/each}
            </div>

            <!-- Vertical connector: Parallel zone → Integrator -->
            <div class="v-connector" class:done={cur>=3} class:flowing={cur===2}>
              <div class="v-line-bg"></div>
              {#if cur>=3}<div class="v-line-fill"></div>{/if}
              {#if cur===2}
                <div class="v-particle vp1"></div>
                <div class="v-particle vp2"></div>
              {/if}
              <div class="v-arrow" class:done={cur>=3}>▼</div>
            </div>

            <!-- Row 3: Integrator → Integration Reviewer → Complete -->
            <div class="dag-row">
              <div class="pipe-node" class:done={cur>3} class:active={cur===3} style="--node-color:{PHASE_META.integrating.color}">
                <div class="pipe-icon">{PHASE_META.integrating.icon}</div>
                <div class="pipe-label">{PHASE_META.integrating.label}</div>
                {#if cur===3}<div class="pipe-glow"></div>{/if}
              </div>
              <div class="pipe-connector" class:done={cur>=4} class:flowing={cur===3}>
                <div class="pipe-line-bg"></div>
                {#if cur>=4}<div class="pipe-line-fill"></div>{/if}
                {#if cur===3}<div class="particle p1"></div><div class="particle p2"></div><div class="particle p3"></div>{/if}
              </div>
              <div class="pipe-node" class:done={cur>4} class:active={cur===4} style="--node-color:{PHASE_META.reviewing.color}">
                <div class="pipe-icon">{PHASE_META.reviewing.icon}</div>
                <div class="pipe-label">Int. Review</div>
                {#if cur===4}<div class="pipe-glow"></div>{/if}
              </div>
              <div class="pipe-connector" class:done={cur>=5} class:flowing={cur===4}>
                <div class="pipe-line-bg"></div>
                {#if cur>=5}<div class="pipe-line-fill"></div>{/if}
                {#if cur===4}<div class="particle p1"></div><div class="particle p2"></div>{/if}
              </div>
              <div class="pipe-node" class:done={cur>=5} style="--node-color:{PHASE_META.complete.color}">
                <div class="pipe-icon">{PHASE_META.complete.icon}</div>
                <div class="pipe-label">{PHASE_META.complete.label}</div>
              </div>
            </div>
          </div>

          <!-- Metrics cards -->
          {#if wfState.totalTasks > 0 || result}
            <div class="metrics">
              <div class="metric-card">
                <div class="metric-value">{wfState.completedTasks}<span class="metric-total">/{wfState.totalTasks}</span></div>
                <div class="metric-label">タスク完了</div>
                <div class="metric-bar"><div class="metric-fill" style="width:{wfState.totalTasks?(wfState.completedTasks/wfState.totalTasks)*100:0}%"></div></div>
              </div>
              {#if result}
                <div class="metric-card">
                  <div class="metric-value">{passRate()}<span class="metric-unit">%</span></div>
                  <div class="metric-label">レビュー通過率</div>
                  <div class="metric-bar"><div class="metric-fill green" style="width:{passRate()}%"></div></div>
                </div>
                <div class="metric-card">
                  <div class="metric-value">{(result.executionTimeMs/1000).toFixed(0)}<span class="metric-unit">s</span></div>
                  <div class="metric-label">実行時間</div>
                </div>
                <div class="metric-card">
                  <div class="metric-value review-badge" class:pass={result.integrationReviewPassed} class:fail={!result.integrationReviewPassed}>
                    {result.integrationReviewPassed?'PASS':'FAIL'}
                  </div>
                  <div class="metric-label">統合レビュー</div>
                </div>
                {#if result.pipelineAttempt > 1}
                  <div class="metric-card">
                    <div class="metric-value">{result.pipelineAttempt}<span class="metric-unit">回</span></div>
                    <div class="metric-label">試行回数</div>
                  </div>
                {/if}
              {:else if wfState.currentlyExecuting.length > 0}
                <div class="metric-card">
                  <div class="metric-value">{wfState.currentlyExecuting.length}</div>
                  <div class="metric-label">並列実行中</div>
                </div>
              {/if}
            </div>
          {/if}

          </div><!-- /wf-left -->
          <div class="wf-right">
          <!-- Tasks -->
          {#if wfState.tasks.length > 0}
            <div class="card">
              <div class="card-header"><span class="card-title">タスク</span></div>
              <div class="task-grid">
                {#each wfState.tasks as task}
                  <button class="task-card" class:rejected={task.status==='rejected'} class:active={task.status==='executing'} onclick={()=>toggleTask(task.id)}>
                    <div class="task-card-top">
                      <span class="task-status-dot" style="background:{statusColor(task.status)}"></span>
                      <span class="task-status-label">{task.status}</span>
                    </div>
                    <div class="task-card-desc">{task.description}</div>
                    {#if expandedTasks.has(task.id) && (task.result || task.reviewNotes)}
                      <div class="task-card-detail" onclick={(e: MouseEvent)=>e.stopPropagation()}>
                        {#if task.result}<div class="task-result markdown">{@html md(task.result)}</div>{/if}
                        {#if task.reviewNotes}<p class="task-review">レビュー: {task.reviewNotes}</p>{/if}
                      </div>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Event log -->
          {#if wfState.events.length > 0}
            <details class="card event-card">
              <summary class="card-header clickable">
                <span class="card-title">アクティビティログ</span>
                <span class="event-count">{wfState.events.length}</span>
              </summary>
              <div class="event-log" bind:this={eventLogEl}>
                {#each wfState.events as event}
                  <div class="event-row">
                    <span class="ev-time">{formatTime(event.timestamp)}</span>
                    <span class="ev-dot" style="color:{eventColor(event.kind)}">{eventIcon(event.kind)}</span>
                    <span class="ev-text">{event.summary}</span>
                  </div>
                {/each}
              </div>
            </details>
          {/if}
          </div><!-- /wf-right -->
          </div><!-- /wf-grid -->
        {:else if loading}
          <div class="loading-state"><span class="spinner lg"></span><p>読み込み中...</p></div>
        {:else if error}
          <div class="card error-card">{error}</div>
        {/if}

        <!-- Result -->
        {#if result}
          <div class="card result-card">
            <div class="card-header">
              <span class="card-title">結果</span>
              <div class="result-actions">
                <button class="action-btn" onclick={copyResult} title="全成果物をクリップボードにコピー">
                  {copied ? '✓ コピー済' : '📋 全体コピー'}
                </button>
                <button class="action-btn" onclick={downloadFullReport} title="全タスク成果物+統合結果をダウンロード">
                  📥 全体DL
                </button>
                <button class="action-btn" onclick={downloadIntegrated} title="統合結果のみダウンロード">
                  📄 統合のみ
                </button>
              </div>
            </div>
            <div class="result-body markdown">{@html md(result.finalResponse)}</div>
          </div>

          <!-- Integration Review Card -->
          {#if result.integrationReviewNotes}
            <div class="card review-card" class:pass={result.integrationReviewPassed} class:fail={!result.integrationReviewPassed}>
              <div class="card-header">
                <span class="card-title">統合レビュー</span>
                <span class="review-verdict" class:pass={result.integrationReviewPassed} class:fail={!result.integrationReviewPassed}>
                  {result.integrationReviewPassed ? 'PASS' : 'FAIL'}
                </span>
              </div>

              {#if result.score}
                {@const score = result.score}
                <div class="score-grid">
                  {#each [
                    { key: '網羅性', val: score.completeness },
                    { key: '正確性', val: score.accuracy },
                    { key: '構造', val: score.structure },
                    { key: '実用性', val: score.actionability },
                    { key: '総合', val: score.overall },
                  ] as item}
                    <div class="score-item">
                      <div class="score-label">{item.key}</div>
                      <div class="score-bar-bg">
                        <div class="score-bar-fill" style="width:{item.val * 20}%; background:{item.val >= 4 ? 'var(--green)' : item.val >= 3 ? 'var(--amber)' : 'var(--red)'}"></div>
                      </div>
                      <div class="score-value">{item.val}</div>
                    </div>
                  {/each}
                </div>
              {/if}

              <div class="review-notes-text markdown">{@html md(result.integrationReviewNotes)}</div>

              {#if result.strengths?.length > 0}
                <div class="review-list strengths">
                  <div class="review-list-title">良かった点</div>
                  {#each result.strengths as s}
                    <div class="review-list-item">✓ {s}</div>
                  {/each}
                </div>
              {/if}

              {#if result.improvements?.length > 0}
                <div class="review-list improvements">
                  <div class="review-list-title">改善点</div>
                  {#each result.improvements as s}
                    <div class="review-list-item">→ {s}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          <button class="run-btn full" onclick={goHome}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            新しいタスク
          </button>
        {/if}
      </div>
    {/if}
  </main>
</div>

<style>
  :root {
    --bg: #0a0b10; --bg2: #12131c; --bg3: #1a1c2a; --bg4: #232538;
    --border: #2a2d42; --border2: #363a54;
    --text: #e8ecf4; --text2: #a0a8c0; --muted: #5a6180;
    --blue: #6c7cff; --blue2: #4f5ccc; --purple: #a78bfa; --cyan: #67e8f9;
    --green: #5ee8a0; --teal: #4fd1c5; --amber: #fbbf24; --red: #f87171;
    --radius: 12px; --radius-sm: 8px;
  }

  :global(*,*::before,*::after) { box-sizing: border-box; }
  :global(body) { margin:0; font-family:'Inter',system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }

  .layout { display:flex; min-height:100vh; }

  /* Sidebar */
  .sidebar { width:280px; flex-shrink:0; background:var(--bg2); border-right:1px solid var(--border); display:flex; flex-direction:column; height:100vh; position:sticky; top:0; }
  .sidebar-header { display:flex; align-items:center; justify-content:space-between; padding:1.2rem 1rem; border-bottom:1px solid var(--border); }
  .logo { display:flex; align-items:center; gap:0.5rem; background:none; border:none; color:var(--text); cursor:pointer; padding:0; }
  .logo-icon { width:28px; height:28px; background:linear-gradient(135deg,var(--blue),var(--purple)); border-radius:8px; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:0.85rem; color:white; }
  .logo-text { font-size:1.05rem; font-weight:700; letter-spacing:-0.02em; }
  .new-btn { display:flex; align-items:center; gap:0.35rem; background:var(--bg3); border:1px solid var(--border); color:var(--text2); border-radius:var(--radius-sm); padding:0.35rem 0.65rem; font-size:0.75rem; font-weight:500; cursor:pointer; transition:all 0.15s; }
  .new-btn:hover { background:var(--bg4); color:var(--text); border-color:var(--border2); }

  .history-list { flex:1; overflow-y:auto; padding:0.5rem; }
  .history-item { display:flex; gap:0.6rem; width:100%; background:transparent; border:none; border-radius:var(--radius-sm); padding:0.55rem 0.6rem; color:var(--text); cursor:pointer; text-align:left; transition:background 0.12s; }
  .history-item:hover { background:var(--bg3); }
  .history-item.active { background:rgba(108,124,255,0.12); }
  .history-indicator { width:3px; border-radius:2px; flex-shrink:0; align-self:stretch; }
  .history-content { flex:1; min-width:0; }
  .history-prompt { font-size:0.8rem; color:var(--text2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.4; }
  .history-item.active .history-prompt { color:var(--text); }
  .history-meta { display:flex; justify-content:space-between; font-size:0.65rem; color:var(--muted); margin-top:0.15rem; }
  .history-empty { text-align:center; padding:3rem 1rem; }
  .history-empty p { margin:0; font-size:0.85rem; color:var(--muted); }
  .history-empty .sub { font-size:0.75rem; margin-top:0.3rem; opacity:0.6; }

  .overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:90; border:none; cursor:default; backdrop-filter:blur(2px); }

  /* Main */
  main { flex:1; min-width:0; padding:2rem 2.5rem; }
  .topbar { display:none; }
  .hamburger { display:flex; flex-direction:column; gap:4px; background:none; border:none; padding:0.5rem; cursor:pointer; }
  .hamburger span { display:block; width:20px; height:2px; background:var(--text2); border-radius:1px; }
  .topbar-title { font-size:1rem; font-weight:700; color:var(--text); cursor:pointer; }

  .home { max-width:700px; }

  /* Animations */
  .fade-in { animation:fadeIn 0.3s ease; }
  @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes spin { to{transform:rotate(360deg)} }

  .spinner { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,0.3); border-top-color:white; border-radius:50%; animation:spin 0.6s linear infinite; }
  .spinner.lg { width:24px; height:24px; border-width:3px; }
  .loading-state { display:flex; flex-direction:column; align-items:center; gap:1rem; padding:4rem 0; color:var(--muted); }

  /* Home */
  .hero { margin-bottom:2rem; }
  h1 { font-size:1.8rem; font-weight:800; margin:0 0 0.3rem; letter-spacing:-0.03em; background:linear-gradient(135deg,var(--text),var(--blue)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .hero-sub { color:var(--muted); font-size:0.9rem; margin:0; }

  /* Card */
  .card { background:var(--bg2); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:1rem; overflow:hidden; }
  .card-header { display:flex; align-items:center; justify-content:space-between; padding:0.75rem 1rem; border-bottom:1px solid var(--border); }
  .card-header.clickable { cursor:pointer; }
  .card-header.clickable:hover { background:var(--bg3); }
  .card-title { font-size:0.8rem; font-weight:600; color:var(--text2); text-transform:uppercase; letter-spacing:0.05em; }

  /* Input card */
  .input-card { padding:1rem; border:1px solid var(--border); }
  .input-card textarea { width:100%; background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text); font-size:0.95rem; padding:0.8rem; resize:vertical; outline:none; font-family:inherit; transition:border-color 0.15s; }
  .input-card textarea:focus { border-color:var(--blue); }
  .input-card textarea::placeholder { color:var(--muted); }
  .input-footer { display:flex; align-items:center; justify-content:space-between; margin-top:0.75rem; gap:0.75rem; }
  .input-options { display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap; }
  .input-options select { background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text2); padding:0.4rem 0.6rem; font-size:0.8rem; outline:none; }
  .retry-input { display:flex; align-items:center; gap:0.35rem; }
  .retry-input label { font-size:0.75rem; color:var(--muted); font-weight:500; white-space:nowrap; }
  .retry-input select { width:auto; }
  .run-btn { display:inline-flex; align-items:center; gap:0.4rem; background:linear-gradient(135deg,var(--blue),var(--purple)); color:white; border:none; border-radius:var(--radius-sm); padding:0.55rem 1.4rem; font-size:0.85rem; font-weight:600; cursor:pointer; transition:opacity 0.15s,transform 0.1s; }
  .run-btn:hover:not(:disabled) { opacity:0.9; transform:translateY(-1px); }
  .run-btn:active:not(:disabled) { transform:translateY(0); }
  .run-btn:disabled { opacity:0.4; cursor:not-allowed; }
  .run-btn.full { width:100%; justify-content:center; margin-top:1rem; }

  /* Tools card */
  .tools-card { padding:0; }
  .tools-card .card-header { padding:0.6rem 1rem; }
  .tool-presets { display:flex; gap:0.25rem; }
  .pill { background:var(--bg); border:1px solid var(--border); color:var(--muted); padding:0.2rem 0.55rem; font-size:0.65rem; border-radius:99px; cursor:pointer; transition:all 0.12s; font-weight:500; }
  .pill:hover { border-color:var(--border2); color:var(--text2); }
  .pill.active { background:var(--blue); border-color:var(--blue); color:white; }
  .tools-grid { display:flex; flex-wrap:wrap; gap:0.35rem; padding:0.65rem 0.8rem; }
  .tool-chip { display:flex; align-items:center; gap:0.3rem; padding:0.3rem 0.55rem; background:var(--bg); border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:0.75rem; transition:all 0.12s; color:var(--text2); }
  .tool-chip:hover { border-color:var(--border2); background:var(--bg3); }
  .tool-chip.active { border-color:var(--blue); background:rgba(108,124,255,0.1); color:var(--text); }
  .tool-icon { font-size:0.8rem; }
  .tool-label { font-weight:500; }

  .error-card { padding:0.8rem 1rem; color:var(--red); font-size:0.85rem; border-color:rgba(248,113,113,0.3); background:rgba(248,113,113,0.06); }

  /* Workflow view */
  .workflow-nav { display:flex; align-items:center; gap:0.6rem; margin-bottom:1.5rem; }
  .back-btn { background:none; border:1px solid var(--border); color:var(--text2); padding:0.3rem; border-radius:6px; cursor:pointer; display:flex; align-items:center; transition:all 0.12s; }
  .back-btn:hover { background:var(--bg3); color:var(--text); }
  .wf-id { font-size:0.75rem; color:var(--muted); }
  .prompt-display {
    background:var(--bg2); border:1px solid var(--border); border-radius:var(--radius);
    margin-bottom:1rem; overflow:hidden;
  }
  .prompt-summary {
    padding:0.6rem 1rem; font-size:0.75rem; font-weight:600; color:var(--muted);
    text-transform:uppercase; letter-spacing:0.04em; cursor:pointer; list-style:none;
  }
  .prompt-summary::-webkit-details-marker { display:none; }
  .prompt-summary::after { content:' ▼'; font-size:0.6rem; }
  .prompt-display[open] .prompt-summary::after { content:' ▲'; }
  .prompt-display-text {
    font-size:0.9rem; color:var(--text); line-height:1.6; white-space:pre-wrap; word-break:break-word;
    padding:0 1rem 0.75rem;
  }
  .phase-badge { font-size:0.65rem; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; padding:0.2rem 0.5rem; border-radius:99px; }
  .phase-badge.running { background:rgba(108,124,255,0.15); color:var(--blue); animation:pulse 1.5s infinite; }
  .phase-badge.done { background:rgba(94,232,160,0.15); color:var(--green); }
  .phase-badge.err { background:rgba(248,113,113,0.15); color:var(--red); }

  /* Workflow 2-column grid */
  .wf-grid { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; align-items:start; }
  .wf-left { display:flex; flex-direction:column; gap:1rem; }
  .wf-right { display:flex; flex-direction:column; gap:1rem; }

  /* Agent DAG Pipeline */
  .dag { display:flex; flex-direction:column; align-items:center; gap:0.75rem; padding:1rem 0; }
  .dag-row { display:flex; align-items:center; gap:0; width:100%; justify-content:center; }
  .dag-parallel {
    display:flex; flex-direction:column; gap:0.4rem; width:100%;
    padding:0.5rem 1rem; background:var(--bg3); border:1px solid var(--border);
    border-radius:var(--radius); position:relative;
  }
  .dag-parallel::before { content:'並列実行'; position:absolute; top:-0.5rem; left:1rem; font-size:0.55rem; color:var(--muted); background:var(--bg3); padding:0 0.4rem; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; }
  .dag-lane { display:flex; align-items:center; gap:0; }
  /* Vertical connectors between rows */
  .v-connector {
    display:flex; flex-direction:column; align-items:center;
    height:36px; position:relative; width:20px;
  }
  .v-line-bg { position:absolute; left:50%; top:0; bottom:12px; width:2px; background:var(--border); transform:translateX(-50%); }
  .v-line-fill {
    position:absolute; left:50%; top:0; bottom:12px; width:2px;
    background:var(--green); transform:translateX(-50%);
    animation:vLineFill 0.4s ease forwards;
  }
  .v-connector.flowing .v-line-fill { background:linear-gradient(180deg, var(--green), var(--blue)); }
  @keyframes vLineFill { from{transform:translateX(-50%) scaleY(0);transform-origin:top} to{transform:translateX(-50%) scaleY(1);transform-origin:top} }
  .v-arrow {
    position:absolute; bottom:0; left:50%; transform:translateX(-50%);
    font-size:0.6rem; color:var(--muted); transition:color 0.3s;
  }
  .v-arrow.done { color:var(--green); }
  .v-particle {
    position:absolute; width:5px; height:5px; border-radius:50%;
    background:var(--blue); left:50%; transform:translateX(-50%);
    box-shadow:0 0 8px var(--blue);
    animation:vParticleFlow 1.5s ease-in-out infinite;
  }
  .v-particle.vp2 { animation-delay:0.7s; width:4px; height:4px; opacity:0.7; }
  @keyframes vParticleFlow {
    0% { top:-4px; opacity:0; }
    10% { opacity:1; }
    90% { opacity:1; }
    100% { top:calc(100% - 16px); opacity:0; }
  }

  .pipe-node.small .pipe-icon { width:32px; height:32px; font-size:0.9rem; border-radius:10px; }
  .pipe-node.small .pipe-label { font-size:0.55rem; }
  .pipe-node.rejected .pipe-icon { border-color:var(--red); background:rgba(248,113,113,0.1); }
  .pipe-node.rejected .pipe-label { color:var(--red); opacity:0.8; }
  .pipe-line-fill.red { background:var(--red); }
  .pipe-connector.short { min-width:16px; flex:0 0 40px; }
  .dag-lane { position:relative; }
  .dag-lane.retrying { background:rgba(251,191,36,0.05); border-radius:6px; }
  .retry-badge {
    position:absolute; top:-0.4rem; right:0.5rem;
    font-size:0.55rem; font-weight:700; color:var(--amber);
    background:rgba(251,191,36,0.15); padding:0.1rem 0.4rem;
    border-radius:99px; text-transform:uppercase; letter-spacing:0.04em;
    animation:pulse 1.5s infinite;
  }

  .pipe-node {
    display:flex; flex-direction:column; align-items:center; gap:0.25rem;
    flex-shrink:0; position:relative; z-index:1; min-width:56px;
  }
  .pipe-icon {
    width:40px; height:40px; border-radius:12px; border:2px solid var(--border);
    display:flex; align-items:center; justify-content:center; font-size:1.1rem;
    background:var(--bg2); transition:all 0.4s cubic-bezier(0.4,0,0.2,1);
  }
  .pipe-label {
    font-size:0.6rem; font-weight:600; color:var(--muted); text-transform:uppercase;
    letter-spacing:0.03em; transition:color 0.3s; white-space:nowrap;
  }
  .pipe-node.done .pipe-icon { border-color:var(--green); background:rgba(94,232,160,0.1); }
  .pipe-node.done .pipe-label { color:var(--green); opacity:0.7; }
  .pipe-node.active .pipe-icon {
    border-color:var(--node-color); background:var(--bg2);
    box-shadow:0 0 16px color-mix(in srgb, var(--node-color) 40%, transparent),
               0 0 4px color-mix(in srgb, var(--node-color) 20%, transparent);
    transform:scale(1.1);
  }
  .pipe-node.active .pipe-label { color:var(--node-color); font-weight:700; }
  .pipe-node.pending .pipe-icon { opacity:0.35; }
  .pipe-node.pending .pipe-label { opacity:0.3; }

  .pipe-glow {
    position:absolute; top:0; left:50%; transform:translateX(-50%);
    width:40px; height:40px; border-radius:12px;
    background:var(--node-color); opacity:0.15; filter:blur(12px);
    animation:glowPulse 2s ease-in-out infinite;
  }
  @keyframes glowPulse { 0%,100%{opacity:0.1;transform:translateX(-50%) scale(1)} 50%{opacity:0.25;transform:translateX(-50%) scale(1.3)} }

  /* Connector with particles */
  .pipe-connector { flex:1; height:20px; position:relative; display:flex; align-items:center; min-width:20px; }
  .pipe-line-bg { position:absolute; left:0; right:0; top:50%; height:2px; background:var(--border); transform:translateY(-50%); border-radius:1px; }
  .pipe-line-fill {
    position:absolute; left:0; right:0; top:50%; height:2px; transform:translateY(-50%);
    background:var(--green); border-radius:1px; animation:lineFill 0.5s ease forwards;
  }
  @keyframes lineFill { from{transform:translateY(-50%) scaleX(0);transform-origin:left} to{transform:translateY(-50%) scaleX(1);transform-origin:left} }

  .pipe-connector.flowing .pipe-line-fill {
    background:linear-gradient(90deg, var(--green), var(--blue));
  }

  .particle {
    position:absolute; width:6px; height:6px; border-radius:50%;
    background:var(--blue); top:50%; transform:translateY(-50%);
    box-shadow:0 0 8px var(--blue), 0 0 3px var(--blue);
    animation:particleFlow 1.8s ease-in-out infinite;
  }
  .particle.p2 { animation-delay:0.6s; width:4px; height:4px; opacity:0.7; }
  .particle.p3 { animation-delay:1.2s; width:5px; height:5px; opacity:0.8; }
  @keyframes particleFlow {
    0% { left:-4px; opacity:0; }
    10% { opacity:1; }
    90% { opacity:1; }
    100% { left:calc(100% - 4px); opacity:0; }
  }

  /* Metrics */
  .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:0.75rem; }
  .metric-card { background:var(--bg2); border:1px solid var(--border); border-radius:var(--radius); padding:1rem; }
  .metric-value { font-size:1.6rem; font-weight:800; letter-spacing:-0.03em; color:var(--text); }
  .metric-total { font-size:0.9rem; font-weight:500; color:var(--muted); }
  .metric-unit { font-size:0.85rem; font-weight:500; color:var(--muted); }
  .metric-label { font-size:0.7rem; color:var(--muted); margin-top:0.25rem; text-transform:uppercase; letter-spacing:0.04em; }
  .metric-bar { height:4px; background:var(--bg4); border-radius:99px; margin-top:0.5rem; overflow:hidden; }
  .metric-fill { height:100%; background:linear-gradient(90deg,var(--blue),var(--purple)); border-radius:99px; transition:width 0.5s ease; }
  .metric-fill.green { background:linear-gradient(90deg,var(--green),var(--teal)); }
  .review-badge { font-size:1.1rem !important; font-weight:800; letter-spacing:0.05em; }
  .review-badge.pass { color:var(--green); }
  .review-badge.fail { color:var(--red); }

  /* Task grid */
  .task-grid { display:flex; flex-direction:column; gap:0.5rem; padding:0.75rem; }
  .task-card { background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.7rem 0.85rem; text-align:left; cursor:pointer; transition:all 0.12s; color:var(--text); }
  .task-card:hover { border-color:var(--border2); background:var(--bg3); }
  .task-card.active { border-color:var(--blue); }
  .task-card.rejected { border-color:rgba(248,113,113,0.3); }
  .task-card-top { display:flex; align-items:center; gap:0.4rem; margin-bottom:0.3rem; }
  .task-status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .task-card.active .task-status-dot { animation:pulse 1.2s infinite; }
  .task-status-label { font-size:0.65rem; color:var(--muted); text-transform:uppercase; font-weight:600; letter-spacing:0.04em; }
  .task-card-desc { font-size:0.82rem; color:var(--text2); line-height:1.4; }
  .task-card-detail { margin-top:0.6rem; padding-top:0.6rem; border-top:1px solid var(--border); }
  .task-result { background:var(--bg2); border-radius:6px; padding:0.6rem; word-break:break-word; font-size:0.72rem; line-height:1.5; margin:0; color:var(--text2); max-height:300px; overflow-y:auto; }
  .task-review { font-size:0.72rem; color:var(--muted); margin:0.4rem 0 0; }

  /* Event log */
  .event-card { border:1px solid var(--border); }
  .event-card summary { list-style:none; }
  .event-card summary::-webkit-details-marker { display:none; }
  .event-count { font-size:0.65rem; background:var(--bg4); color:var(--text2); padding:0.15rem 0.45rem; border-radius:99px; font-weight:600; }
  .event-log { max-height:260px; overflow-y:auto; padding:0.5rem; font-family:'JetBrains Mono','Fira Code',monospace; font-size:0.7rem; }
  .event-row { display:flex; align-items:baseline; gap:0.4rem; padding:0.18rem 0.4rem; border-radius:4px; }
  .event-row:hover { background:var(--bg3); }
  .ev-time { color:var(--muted); flex-shrink:0; font-size:0.65rem; opacity:0.7; }
  .ev-dot { width:0.8rem; text-align:center; flex-shrink:0; }
  .ev-text { color:var(--text2); word-break:break-word; }

  /* Result */
  .result-card .card-header { border-bottom:1px solid var(--border); }
  .result-actions { display:flex; gap:0.35rem; }
  .action-btn {
    background:var(--bg); border:1px solid var(--border); color:var(--text2);
    padding:0.25rem 0.6rem; font-size:0.7rem; border-radius:6px; cursor:pointer;
    transition:all 0.12s; white-space:nowrap;
  }
  .action-btn:hover { background:var(--bg3); color:var(--text); border-color:var(--border2); }
  .result-body { padding:1rem; word-break:break-word; font-family:inherit; font-size:0.85rem; line-height:1.7; color:var(--text); margin:0; }

  /* Markdown rendered content */
  :global(.markdown h1) { font-size:1.3rem; font-weight:700; margin:0.8rem 0 0.4rem; color:var(--text); border-bottom:1px solid var(--border); padding-bottom:0.3rem; }
  :global(.markdown h2) { font-size:1.1rem; font-weight:700; margin:0.7rem 0 0.35rem; color:var(--text); }
  :global(.markdown h3) { font-size:0.95rem; font-weight:600; margin:0.6rem 0 0.3rem; color:var(--text); }
  :global(.markdown h4) { font-size:0.85rem; font-weight:600; margin:0.5rem 0 0.25rem; color:var(--text2); }
  :global(.markdown p) { margin:0.4rem 0; }
  :global(.markdown ul, .markdown ol) { margin:0.4rem 0; padding-left:1.5rem; }
  :global(.markdown li) { margin:0.15rem 0; }
  :global(.markdown strong) { color:var(--text); font-weight:600; }
  :global(.markdown a) { color:var(--blue); text-decoration:none; }
  :global(.markdown a:hover) { text-decoration:underline; }
  :global(.markdown hr) { border:none; border-top:1px solid var(--border); margin:0.8rem 0; }
  :global(.markdown blockquote) { margin:0.5rem 0; padding:0.4rem 0.8rem; border-left:3px solid var(--border2); color:var(--text2); background:var(--bg3); border-radius:0 6px 6px 0; }
  :global(.markdown table) { width:100%; border-collapse:collapse; margin:0.5rem 0; font-size:0.8rem; }
  :global(.markdown th) { text-align:left; padding:0.45rem 0.65rem; background:var(--bg3); border:1px solid var(--border); color:var(--text); font-weight:600; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
  :global(.markdown td) { padding:0.4rem 0.65rem; border:1px solid var(--border); color:var(--text2); }
  :global(.markdown tr:hover td) { background:var(--bg3); }
  :global(.markdown code) { background:var(--bg3); padding:0.15rem 0.35rem; border-radius:4px; font-size:0.82em; font-family:'JetBrains Mono','Fira Code',monospace; color:var(--cyan); }
  :global(.markdown pre) { background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0.75rem; margin:0.5rem 0; overflow-x:auto; }
  :global(.markdown pre code) { background:none; padding:0; font-size:0.78rem; color:var(--text2); line-height:1.6; }
  :global(.markdown img) { max-width:100%; border-radius:var(--radius-sm); }
  .review-card { overflow:hidden; }
  .review-card.pass { border-color:rgba(94,232,160,0.3); }
  .review-card.fail { border-color:rgba(248,113,113,0.3); }
  .review-verdict { font-size:0.7rem; font-weight:800; padding:0.15rem 0.5rem; border-radius:99px; letter-spacing:0.05em; }
  .review-verdict.pass { background:rgba(94,232,160,0.15); color:var(--green); }
  .review-verdict.fail { background:rgba(248,113,113,0.15); color:var(--red); }

  .score-grid { display:flex; flex-direction:column; gap:0.4rem; padding:0.75rem 1rem; border-bottom:1px solid var(--border); }
  .score-item { display:flex; align-items:center; gap:0.5rem; }
  .score-label { font-size:0.7rem; color:var(--text2); width:3.5rem; flex-shrink:0; font-weight:500; }
  .score-bar-bg { flex:1; height:6px; background:var(--bg4); border-radius:99px; overflow:hidden; }
  .score-bar-fill { height:100%; border-radius:99px; transition:width 0.5s ease; }
  .score-value { font-size:0.75rem; font-weight:700; color:var(--text); width:1.2rem; text-align:right; }

  .review-notes-text { padding:0.75rem 1rem; font-size:0.82rem; line-height:1.6; color:var(--text2); border-bottom:1px solid var(--border); }
  .review-list { padding:0.6rem 1rem; }
  .review-list + .review-list { border-top:1px solid var(--border); }
  .review-list-title { font-size:0.7rem; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:0.3rem; }
  .review-list-item { font-size:0.8rem; color:var(--text2); line-height:1.5; padding:0.1rem 0; }
  .strengths .review-list-item { color:var(--green); }
  .improvements .review-list-item { color:var(--amber); }

  /* Mobile */
  @media (max-width:1024px) {
    .wf-grid { grid-template-columns:1fr; }
  }
  @media (max-width:768px) {
    .sidebar { position:fixed; left:0; top:0; z-index:100; transform:translateX(-100%); transition:transform 0.25s cubic-bezier(0.4,0,0.2,1); width:280px; }
    .sidebar.open { transform:translateX(0); }
    .overlay { display:block; }
    .topbar { display:flex; align-items:center; gap:0.75rem; margin-bottom:1.5rem; }
    main { padding:1rem 1.25rem; }
    .hero h1 { font-size:1.4rem; }
    .metrics { grid-template-columns:repeat(2,1fr); }
  }
</style>
