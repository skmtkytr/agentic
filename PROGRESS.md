# Agentic — 実装状況 & ロードマップ

## 概要

Temporal.io + Claude Agent SDK を使った AI マルチエージェント ワークフローエンジン。
1つのプロンプトを受け取り、6つの専門エージェントがパイプライン処理して最終回答を生成する。

```
Prompt
  └─► [Planner] → [Validator] → [Executor×N (parallel DAG)] → [Reviewer×N] → [Integrator] → [Integration Reviewer]
                                                                                                        └─► Final Response
```

---

## 実装済み ✅

### コアエンジン

| ファイル | 内容 |
|---|---|
| `src/workflows/agenticWorkflow.ts` | メインワークフロー。フェーズ管理・DAG並列実行・Signal/Query・イベントログ |
| `src/activities/plannerActivity.ts` | プロンプト → タスクDAGに分解 |
| `src/activities/validatorActivity.ts` | DAGの妥当性検証（循環依存・網羅性） |
| `src/activities/executorActivity.ts` | 各タスクを依存タスクの結果をコンテキストとして実行 |
| `src/activities/reviewerActivity.ts` | タスク結果の品質レビュー（修正も可） |
| `src/activities/integratorActivity.ts` | レビュー済みタスクを統合して一貫した回答を生成 |
| `src/activities/integrationReviewerActivity.ts` | 統合結果の最終QA |

### LLM層

| ファイル | 内容 |
|---|---|
| `src/llm/parseWithRetry.ts` | `callStructured` (JSON + Zod検証) / `callRawText` (テキスト出力) |
| — | `tools: []` + `permissionMode: 'dontAsk'` でツール無効化（構造化出力時） |
| — | `allowedTools` + `permissionMode: 'dontAsk'` でツール許可制御（実行時） |

### Web UI (Svelte + Vite)

| ファイル | 内容 |
|---|---|
| `web/src/App.svelte` | プロンプト入力、ツール権限設定、リアルタイム状態表示、イベントログ |
| `src/server/app.ts` | Express API (DI対応ファクトリ) |
| `src/server.ts` | サーバーエントリーポイント |

**API エンドポイント:**
- `POST /api/run` — ワークフロー起動
- `GET /api/workflows` — 履歴一覧（ステータス補完付き）
- `GET /api/workflow/:id` — ワークフロー詳細
- `GET /api/status/:id` — SSE リアルタイムストリーミング
- `GET /api/result/:id` — 最終結果取得

**UI 機能:**
- ツール権限管理（Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/NotebookEdit）
- プリセット（なし / 読み取り専用 / すべて）
- リアルタイムフェーズステッパー・タスクリスト・アクティビティログ
- ワークフロー履歴パネル（プロンプト・ステータス・日時）
- URL ハッシュ永続化（リロード時に復元）

### Temporal 機能

- **DAG並列実行**: 依存が満たされたタスクを `Promise.all` で並列実行（wave-based）
- **Retry Policy**: planner/validator は3回、executor/reviewer は5回、認証エラーは即失敗
- **Signal**: `cancelSignal` でワークフローをキャンセル
- **Query**: `statusQuery` でリアルタイムの実行フェーズ・タスク状態・イベントログを取得
- **Activity Events**: 各アクティビティの開始/完了をタイムスタンプ付きで記録

### テスト (94 tests)

| ファイル | テスト数 | 内容 |
|---|---|---|
| `tests/llm/parseWithRetry.test.ts` | 17 | callStructured / callRawText のオプション・エラー処理 |
| `tests/types/schemas.test.ts` | 20 | 全Zodスキーマのバリデーション |
| `tests/activities/plannerActivity.test.ts` | 4 | UUID再マップ・JSON/スキーマエラー |
| `tests/activities/validatorActivity.test.ts` | 5 | valid/invalid・revisedPlan |
| `tests/activities/executorActivity.test.ts` | 5 | 実行・コンテキスト注入・allowedTools |
| `tests/activities/reviewerActivity.test.ts` | 5 | pass/fail・revisedResult |
| `tests/activities/integratorActivity.test.ts` | 4 | 結果統合・allowedTools |
| `tests/activities/integrationReviewerActivity.test.ts` | 5 | pass/fail・revisedResponse |
| `tests/server/app.test.ts` | 18 | 全APIエンドポイント・エラー処理・履歴管理 |
| `tests/workflows/agenticWorkflow.test.ts` | 11 | Happy-path・依存チェーン・allowedTools・イベントログ |

---

## ロードマップ

### v0.2 — エージェント間インターフェース改善（次のステップ）

**課題**: Executor がツールで取得したデータの証跡が後段エージェントに伝わらない。Integration Reviewer が「ツール使用の証拠がない」として結果を却下するケースが発生。

**改善内容:**

1. **`ExecutorResponse` の型拡張**
   ```typescript
   interface ToolUsageRecord {
     tool: string;       // 'WebFetch', 'Bash', etc.
     input: string;      // URL, command, etc.
     output: string;     // 取得結果のサマリー
     timestamp: number;
   }

   interface ExecutorResponse {
     taskId: string;
     result: string;
     toolUsage: ToolUsageRecord[];  // NEW: ツール使用の証跡
     sources: string[];             // NEW: 参照元URL等
   }
   ```

2. **Reviewer に証跡を渡す** — `ReviewerRequest` に `toolUsage` を追加し、「このデータはWebFetchで取得済み」を判断材料にする

3. **Integration Reviewer に全タスクの証跡を集約** — 統合結果のファクトチェックに使えるようにする

4. **Executor のプロンプト改善** — ツール使用時に出力フォーマットを指定し、ソースURLや取得日時を明記させる

5. **Agent SDK の `query()` メッセージからツール使用を自動抽出** — `message.type === 'tool_use'` をパースして `ToolUsageRecord` を構築

### v0.3 — ワークスペースとサンドボックス

- ワークスペースディレクトリの概念を導入（`WorkflowInput.workspaceDir`）
- Executor がファイル読み書き・コード実行を行うときの作業ディレクトリ
- サンドボックス実行環境（Docker コンテナ内での安全な実行）

### v0.4 — エージェント設定のカスタマイズ

- UIからモデル選択（claude-opus / sonnet / haiku）をアクティビティ単位で
- 最大並列タスク数の設定
- エージェントへのシステムプロンプトカスタマイズ

### v0.5 — マルチワークフロー・子ワークフロー

- 大規模タスクを子ワークフロー（Child Workflow）として委譲
- 複数ワークフローの並列実行と依存管理
- ワークフロー間のコンテキスト共有

### v1.0 — 本番運用

- Temporal Cloud 対応（認証・namespace 管理）
- レート制限・コスト管理（トークン使用量の追跡）
- ログ・トレース（OpenTelemetry 連携）
- Docker Compose 構成（Temporal + Worker + Web UI）

---

## 起動方法

```bash
# 1. Temporal server 起動
temporal server start-dev

# 2. Worker 起動（別ターミナル）
npm run worker

# 3a. CLI で実行
npm start "TypeScriptでRESTful APIを設計してください"

# 3b. Web UI で実行
npm run server       # http://localhost:3001
npm run web:dev      # http://localhost:5173 (開発時ホットリロード)
```

## 環境変数

```bash
# .env.example 参照
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLAUDE_MODEL=claude-opus-4-6
# ANTHROPIC_API_KEY は不要（Claude Code SDK が OAuth を使用）
```
