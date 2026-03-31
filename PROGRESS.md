# Agentic — 実装状況 & ロードマップ

## 概要

Temporal.io + Anthropic Claude を使った AI マルチエージェント ワークフローエンジン。
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
| `src/workflows/agenticWorkflow.ts` | メインワークフロー。フェーズ管理・DAG並列実行・Signal/Query |
| `src/activities/plannerActivity.ts` | プロンプト → タスクDAGに分解 |
| `src/activities/validatorActivity.ts` | DAGの妥当性検証（循環依存・網羅性） |
| `src/activities/executorActivity.ts` | 各タスクを依存タスクの結果をコンテキストとして実行 |
| `src/activities/reviewerActivity.ts` | タスク結果の品質レビュー（修正も可） |
| `src/activities/integratorActivity.ts` | レビュー済みタスクを統合して一貫した回答を生成 |
| `src/activities/integrationReviewerActivity.ts` | 統合結果の最終QA |

### インフラ・型定義

| ファイル | 内容 |
|---|---|
| `src/llm/parseWithRetry.ts` | JSON prompting + Zod バリデーション + Temporal retry 連携 |
| `src/llm/client.ts` | Anthropic client factory（SDKリトライ無効化、Temporal に一元化） |
| `src/types/` | Task / Workflow / Agent の型定義 + Zod スキーマ |
| `src/worker.ts` | Temporal Worker 起動 |
| `src/client.ts` | CLI から workflow を起動して結果を待つ |

### Temporal 機能

- **DAG並列実行**: 依存が満たされたタスクを `Promise.all` で並列実行（wave-based）
- **Retry Policy**: planner/validator は3回、executor/reviewer は5回、認証エラーは即失敗
- **Signal**: `cancelSignal` でワークフローをキャンセル
- **Query**: `statusQuery` でリアルタイムの実行フェーズとタスク進捗を取得

### テスト

| ファイル | 内容 |
|---|---|
| `tests/activities/plannerActivity.test.ts` | JSON parse / schema validation / UUID remapping / コードフェンス除去 |
| `tests/workflows/agenticWorkflow.test.ts` | ハッピーパス / タスク拒否 / バリデーション失敗 / 並列実行 |

**現状: 9/9 テスト PASS**

---

## ロードマップ

### v0.2 — Web UI（次のステップ）

Svelte + Vite で構築するフロントエンド。Express バックエンドが Temporal Client のラッパーになる。

```
web/
├── package.json         (Svelte + Vite)
├── src/
│   ├── App.svelte       ルートコンポーネント
│   ├── lib/
│   │   ├── PromptForm.svelte   プロンプト入力フォーム
│   │   ├── WorkflowStatus.svelte  フェーズ・タスク進捗のリアルタイム表示
│   │   ├── TaskList.svelte        タスク一覧と各タスクの状態
│   │   └── ResultView.svelte      最終回答の表示（Markdown レンダリング）
│   └── stores/
│       └── workflow.ts  Svelte store でワークフロー状態を管理
└── ...

src/
└── server.ts            Express API サーバー
    ├── POST /api/run    → Temporal workflow 起動
    ├── GET  /api/status/:id  → SSE でリアルタイム状態ストリーミング
    └── GET  /api/result/:id  → 最終結果取得
```

**リアルタイム状態表示イメージ:**

```
Phase: executing  [████████░░░░] 4/7 tasks

✅ Research background    [reviewed]
✅ Define requirements    [reviewed]
🔄 Write draft            [executing]
🔄 Design architecture   [executing]
⏳ Write tests            [pending]
⏳ Review code            [pending]
⏳ Write documentation    [pending]
```

### v0.3 — ワークフロー履歴・ダッシュボード

- 過去の実行履歴を一覧表示（workflowId / prompt / 実行時間 / 成否）
- 各実行の詳細ページ（タスクごとの入出力、レビューノート）
- Temporal Web UI へのリンク

### v0.4 — エージェント設定のカスタマイズ

- UIからモデル選択（claude-opus / sonnet / haiku）
- 最大並列タスク数の設定
- エージェントへのシステムプロンプトカスタマイズ

### v0.5 — ツール使用（Tool Use）

- Executor がファイル読み書き・コード実行・Web検索などのツールを使えるようにする
- ワークスペースディレクトリの概念を導入（WorkflowInput に `workspaceDir` を追加）
- サンドボックス実行環境（Docker コンテナ内での安全な実行）

### v0.6 — マルチワークフロー・子ワークフロー

- 大規模タスクを子ワークフロー（Child Workflow）として委譲
- 複数ワークフローの並列実行と依存管理
- ワークフロー間のコンテキスト共有

### v1.0 — 本番運用

- Temporal Cloud 対応（認証・namespace 管理）
- レート制限・コスト管理（トークン使用量の追跡）
- ログ・トレース（OpenTelemetry 連携）
- Docker Compose 構成（Temporal + Worker + Web UI）

---

## 起動方法（現在）

```bash
# 1. Temporal server 起動
temporal server start-dev

# 2. Worker 起動（別ターミナル）
npm run worker

# 3. ワークフロー実行
npm start "TypeScriptでRESTful APIを設計してください"
```

## 環境変数

```bash
ANTHROPIC_API_KEY=sk-ant-...
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
CLAUDE_MODEL=claude-opus-4-5
```
