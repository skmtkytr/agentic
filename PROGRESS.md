# Agentic — 実装状況 & ロードマップ

## 概要

Temporal.io + Claude Agent SDK を使った AI マルチエージェント ワークフローエンジン。
1つのプロンプトを受け取り、7つの専門エージェントがパイプライン処理して最終回答を生成する。

```
Prompt
  └─► [Planner] → [Task Designer] → [Executor×N (parallel DAG)] → [Reviewer×N] → [Integrator] → [Integration Reviewer]
                                                                                                        └─► Final Response
```

---

## 実装済み ✅

### コアエンジン

| ファイル | 内容 |
|---|---|
| `src/workflows/agenticWorkflow.ts` | メインワークフロー。6フェーズ管理・DAG wave-based 並列実行・Signal/Query・イベントログ (12種)・パイプラインリトライ・タスクリトライ |
| `src/activities/plannerActivity.ts` | プロンプト → タスクDAGに分解 (userIntent, qualityGuidelines 抽出) |
| `src/activities/taskDesignerActivity.ts` | DAG妥当性検証 + タスクごとの実行ガイダンス設計 (purpose, successCriteria, outputFormat) |
| `src/activities/executorActivity.ts` | 各タスクを依存タスクの結果をコンテキストとして実行、ツール証跡を自動抽出 |
| `src/activities/reviewerActivity.ts` | タスク結果の品質レビュー（ツール証跡ベースのファクトチェック付き） |
| `src/activities/integratorActivity.ts` | レビュー済みタスクを統合して一貫した回答を生成（情報源セクション強制） |
| `src/activities/integrationReviewerActivity.ts` | 統合結果の最終QA（5段階スコアリング、overall≥4で合格） |
| `src/activities/artifactStore.ts` | 実行結果・ツール証跡のファイル永続化 |

### LLM層

| ファイル | 内容 |
|---|---|
| `src/llm/parseWithRetry.ts` | `callStructured` (JSON + Zod検証) / `callRawText` (テキスト出力) |
| `src/llm/provider.ts` | LLMProvider インターフェース (name, supportsTools, call) |
| `src/llm/providerRegistry.ts` | プロバイダーの登録・解決 (シングルトン) |
| `src/llm/providers/claudeAgent.ts` | Claude Agent SDK プロバイダー (OAuth, ツール使用, fallbackModel 対応) |
| `src/llm/providers/anthropicApi.ts` | Anthropic API プロバイダー (直接HTTPクライアント, ローカルLLM対応) |

**主要機能:**
- `tools: []` + `permissionMode: 'dontAsk'` でツール無効化（構造化出力時）
- `allowedTools` + `permissionMode: 'dontAsk'` でツール許可制御（実行時）
- ツール使用の自動抽出: `tool_use` / `tool_result` メッセージをパースして `ToolUsageRecord[]` を構築
- フォールバックモデル: プライマリ失敗時に別モデルへ自動切替

### Web UI (Svelte + Vite)

| ファイル | 内容 |
|---|---|
| `web/src/App.svelte` | プロンプト入力、プロバイダー/モデル選択、ツール権限設定、エージェント別設定、リアルタイム状態表示、イベントログ、5段階スコア表示 |
| `src/server/app.ts` | Express API (DI対応ファクトリ) |
| `src/server.ts` | サーバーエントリーポイント |

**API エンドポイント:**
- `POST /api/run` — ワークフロー起動 (agentConfig, retry設定対応)
- `GET /api/workflows` — 履歴一覧（ステータス補完付き、直近50件）
- `GET /api/workflow/:id` — ワークフロー詳細（設定・状態・結果・失敗理由）
- `GET /api/status/:id` — SSE リアルタイムストリーミング
- `GET /api/result/:id` — 最終結果取得
- `GET /api/local-models` — ローカルLLMモデル一覧

**UI 機能:**
- プロバイダー選択 (claude-agent / local-llm / local-llm-direct / anthropic-api)
- モデル選択 (動的: プロバイダーに応じてローカルモデルも表示)
- ツール権限管理 (Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/NotebookEdit)
- プリセット（なし / 読み取り専用 / すべて）
- エージェント別モデル・プロバイダー設定
- リアルタイムフェーズステッパー・タスクリスト・アクティビティログ
- 統合レビュースコア表示 (5段階 + 強み・改善点)
- ワークフロー履歴パネル（プロンプト・ステータス・日時）
- URL ハッシュ永続化（リロード時に復元）

### Temporal 機能

- **DAG並列実行**: 依存が満たされたタスクを wave-based で並列実行 (`maxParallelTasks` で上限制御)
- **Retry Policy**: planner/designer/reviewer は3回、executor は5回、認証エラーは即失敗
- **Signal**: `cancelSignal` でワークフローをキャンセル
- **Query**: `statusQuery` でリアルタイムの実行フェーズ・タスク状態・イベントログを取得
- **Activity Events**: 12種のイベントをタイムスタンプ付きで記録
- **パイプラインリトライ**: 統合レビュー不合格時にフィードバック付きで全体やり直し
- **タスクリトライ**: Reviewer 不合格時にフィードバック付きで Executor→Reviewer を再実行

### ツール証跡パイプライン (旧 v0.2)

- **ExecutorResponse.toolUsage[]**: Executor のツール使用を `ToolUsageRecord` として自動記録
- **ReviewerRequest.toolUsage[]**: Reviewer がツール証跡ベースでファクトチェック
- **IntegrationReviewerRequest.toolEvidence[]**: 全タスクのツール証跡を集約して最終QAに使用
- **Agent SDK 自動抽出**: `query()` メッセージの `tool_use` / `tool_result` ブロックをパース
- **アーティファクトストア**: 結果 (`result.md`) とツール証跡 (`tool-evidence.json`) をファイルに永続化

### エージェント別設定 (旧 v0.4 の一部)

- **AgentConfigMap**: `agentConfig` で役割 (planner, taskDesigner, executor, ...) ごとにモデル・プロバイダーを上書き
- **DEFAULT_AGENT_CONFIG**: 環境変数でデフォルト設定を指定
- **Web UI**: エージェント別設定エディタ

### Docker Compose

| サービス | イメージ | ポート | 役割 |
|---|---|---|---|
| postgres | postgres:16-alpine | 5432 | Temporal DB |
| temporal | temporalio/auto-setup | 7233 | ワークフロー管理 |
| temporal-ui | temporalio/ui | 8080 | Temporal コンソール |
| server | カスタム (Dockerfile) | 3001 | Express API + Web UI |
| worker | カスタム (Dockerfile) | — | アクティビティ実行 |
| web-dev | カスタム (web/Dockerfile.dev) | 5173 | Vite dev (profiles: [dev]) |

### テスト (209 tests)

| ファイル | テスト数 | 内容 |
|---|---|---|
| `tests/llm/parseWithRetry.test.ts` | 17 | callStructured / callRawText のオプション・エラー処理 |
| `tests/llm/claudeAgentProvider.test.ts` | 11 | ツール抽出・タイムアウト・フォールバックモデル |
| `tests/llm/anthropicApiProvider.test.ts` | 8 | API呼び出し・baseURL上書き |
| `tests/llm/providerRegistry.test.ts` | 6 | 登録・デフォルトプロバイダー・解決 |
| `tests/llm/provider.test.ts` | 8 | インターフェース契約検証 |
| `tests/types/schemas.test.ts` | 20 | 全Zodスキーマのバリデーション |
| `tests/activities/plannerActivity.test.ts` | 4 | UUID再マップ・JSON/スキーマエラー |
| `tests/activities/taskDesignerActivity.test.ts` | 7 | valid/invalid・循環依存検出・ガイダンス設計 |
| `tests/activities/executorActivity.test.ts` | 17 | 実行・コンテキスト注入・ツール証跡抽出・アーティファクト永続化 |
| `tests/activities/reviewerActivity.test.ts` | 9 | pass/fail・ファイルパス処理・ツール証跡検証 |
| `tests/activities/integratorActivity.test.ts` | 7 | 結果統合・ファイル読み取り・情報源保存 |
| `tests/activities/integrationReviewerActivity.test.ts` | 9 | 5段階スコアリング・合格閾値・証跡検証 |
| `tests/activities/artifactStore.test.ts` | 6 | ファイルI/O・パス生成・ディレクトリ作成 |
| `tests/server/app.test.ts` | 18 | 全APIエンドポイント・エラー処理・履歴管理 |
| `tests/workflows/agenticWorkflow.test.ts` | 11 | DAG並列実行・依存チェーン・リトライ・イベントログ |

---

## ロードマップ

### v0.3 — ワークスペースとサンドボックス

- ワークスペースディレクトリの概念を導入（`WorkflowInput.workspaceDir`）
- Executor がファイル読み書き・コード実行を行うときの作業ディレクトリ
- サンドボックス実行環境（Docker コンテナ内での安全な実行）

### v0.4 — 高度なエージェント設定

- 最大並列タスク数の UI 設定
- エージェントへのシステムプロンプトカスタマイズ

### v0.5 — マルチワークフロー・子ワークフロー

- 大規模タスクを子ワークフロー（Child Workflow）として委譲
- 複数ワークフローの並列実行と依存管理
- ワークフロー間のコンテキスト共有

### v1.0 — 本番運用

- Temporal Cloud 対応（認証・namespace 管理）
- レート制限・コスト管理（トークン使用量の追跡）
- ログ・トレース（OpenTelemetry 連携）

---

## 起動方法

```bash
# Docker Compose (推奨)
npm run docker:up          # http://localhost:3001

# ローカル開発
temporal server start-dev  # ターミナル 1
npm run worker             # ターミナル 2
npm run server             # ターミナル 3: http://localhost:3001
npm run web:dev            # ターミナル 4 (オプション): http://localhost:5173

# CLI
npm start "TypeScriptでRESTful APIを設計してください"
```

## 環境変数

```bash
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLAUDE_MODEL=claude-opus-4-6
PORT=3001
ARTIFACT_DIR=/tmp/agentic

# ローカル LLM (オプション)
LOCAL_LLM_BASE_URL=http://localhost:1234
LOCAL_LLM_MODEL=mistral
LOCAL_LLM_FALLBACK_MODEL=mistral

# エージェント別デフォルト (オプション)
DEFAULT_AGENT_CONFIG='{"planner":{"model":"claude-haiku-4-5"}}'

# ANTHROPIC_API_KEY は Claude Agent SDK 使用時は不要（OAuth を使用）
```
