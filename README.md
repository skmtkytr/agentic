# Agentic

Temporal.io + Claude Agent SDK によるマルチエージェント ワークフローエンジン。

1つのプロンプトから7種の専門エージェントがパイプライン処理し、5段階スコアリング付きの最終回答を生成します。

```
Prompt
  └─ Planner ──► Task Designer
                     │
                     ▼
             ┌───────────────┐
             │  並列実行       │
             │ Executor₁→Rev₁ │
             │ Executor₂→Rev₂ │
             │ Executor₃→Rev₃ │
             └───────┬───────┘
                     ▼
      Integrator ──► Integration Reviewer ──► Final Response
```

## 特徴

- **DAG 並列実行** — 依存のないタスクは wave-based で自動並列実行
- **2段階リトライ** — タスクレベル (Executor→Reviewer) とパイプラインレベル (全体やり直し)
- **ツール使用** — WebFetch, WebSearch, Bash, Read/Write/Edit 等を Executor に許可
- **ツール証跡** — Executor のツール使用を自動抽出し、Reviewer / Integration Reviewer に渡してファクトチェック
- **5段階スコアリング** — Integration Reviewer が完全性・正確性・構造・実用性・総合で採点
- **マルチプロバイダー** — Claude Agent SDK / Anthropic API / ローカル LLM を切り替え可能
- **エージェント別モデル設定** — Planner は Opus、Executor は Sonnet など役割ごとにモデル・プロバイダーを指定可能
- **アーティファクトストア** — Executor の実行結果・ツール証跡をファイルに永続化
- **リアルタイム Web UI** — SSE でフェーズ進行、タスク状態、アクティビティログをライブ表示
- **ワークフロー履歴** — Temporal から過去の実行をブラウズ、結果を再表示
- **Markdown レンダリング** — テーブル、コードブロック、リストをリッチに表示
- **日本語出力** — 全エージェントが日本語で応答

## クイックスタート

### Docker Compose (推奨)

最もシンプルな方法。Temporal, Worker, Web UI を一発で起動します。

#### 前提条件

- Docker & Docker Compose
- Claude Code CLI がローカルで認証済みであること

#### 1. Claude Code の認証

コンテナは Claude Code CLI の OAuth セッションをホストから引き継ぎます。
まだ認証していない場合は、ローカルで一度実行してください:

```bash
# Claude Code CLI をインストール (まだの場合)
npm install -g @anthropic-ai/claude-code

# 認証 (ブラウザが開きます)
claude auth login
```

> **macOS の場合**: Claude Code v2.1+ は認証情報を macOS キーチェーンに保存します。
> Docker コンテナはキーチェーンにアクセスできないため、起動スクリプトが自動的にキーチェーンからファイルに同期します。

#### 2. 起動

```bash
git clone https://github.com/skmtkytr/agentic.git
cd agentic
npm install

# キーチェーン同期 + Docker 起動を一発で
npm run docker:up
```

または手動で:

```bash
# キーチェーンから認証情報を同期 (macOS)
bash scripts/sync-credentials.sh

# Docker 起動
docker compose up --build
```

#### 3. アクセス

| サービス | URL | 説明 |
|---|---|---|
| **Web UI** | http://localhost:3001 | メインのダッシュボード |
| **Temporal UI** | http://localhost:8080 | ワークフロー管理コンソール |

#### 停止

```bash
docker compose down
```

#### Claude 認証パスのカスタマイズ

デフォルトでは `~/.config/claude` をマウントします。別の場所にある場合:

```bash
CLAUDE_CONFIG_DIR=/path/to/.claude docker compose up --build
```

#### トラブルシューティング

**認証エラー (`OAuth token has expired`)**

Claude Code v2.1+ は認証情報を macOS キーチェーンに保存するため、Docker コンテナからは直接参照できません。

```bash
# 1. キーチェーンから認証情報を再同期
bash scripts/sync-credentials.sh

# 2. コンテナを再起動
docker compose restart worker server
```

トークンが完全に失効している場合:

```bash
claude auth login
bash scripts/sync-credentials.sh
docker compose restart worker server
```

**Temporal 接続エラー**

Temporal の起動に数秒かかります。Worker/Server が先に起動してエラーになる場合は少し待って:

```bash
docker compose restart worker server
```

---

### ローカル開発

Docker を使わず、各コンポーネントを個別に起動する方法。

#### 前提条件

- Node.js 22+
- Temporal CLI (`brew install temporal` or [公式ドキュメント](https://docs.temporal.io/cli))
- Claude Code CLI (認証済み)

#### セットアップ

```bash
git clone https://github.com/skmtkytr/agentic.git
cd agentic
npm install
cd web && npm install && cd ..
```

#### 起動 (3つのターミナル)

```bash
# ターミナル 1: Temporal Server
temporal server start-dev

# ターミナル 2: Worker
npm run worker

# ターミナル 3: API Server + Web UI
npm run server
# → http://localhost:3001
```

#### 開発時 (Vite ホットリロード)

```bash
# ターミナル 4 (オプション): Vite dev server
npm run web:dev
# → http://localhost:5173 (API は 3001 にプロキシ)
```

#### CLI から直接実行

```bash
npm start "TypeScriptでRESTful APIを設計してください"
```

## Web UI の使い方

### 新規ワークフロー

1. プロンプトを入力
2. プロバイダーを選択 (claude-agent / local-llm / local-llm-direct / anthropic-api)
3. モデルを選択 (Opus 4.6 / Sonnet 4.6 / Haiku 4.5 / ローカルモデル)
4. ツール権限を設定 (なし / 読取 / 全て、または個別選択)
5. リトライ回数を設定
   - **全体リトライ**: 統合レビュー失敗時にパイプライン全体をやり直す回数
   - **タスクリトライ**: 個別タスクのレビュー失敗時に Executor→Reviewer を再実行する回数
6. エージェント別設定 (オプション): 役割ごとにモデル・プロバイダーを上書き
7. 「実行」をクリック

### ダッシュボード

- **パイプライン可視化**: 各エージェントの進行状況をアニメーション付きで表示
  - 並列実行ゾーンでタスクごとの Executor→Reviewer レーンを表示
  - パーティクルアニメーションでデータの流れを可視化
- **メトリクスカード**: タスク完了数、実行時間
- **アクティビティログ**: 全エージェントの開始/完了をタイムスタンプ付きで記録
- **タスク詳細**: 各タスクの実行結果とレビューノートを展開表示
- **統合レビュースコア**: 5段階 (完全性・正確性・構造・実用性・総合) + 強み・改善点
- **結果**: Markdown レンダリング (テーブル、コード、リスト対応)

### ワークフロー履歴

- 左サイドバーに過去のワークフローを表示
- プロンプト、ステータス、実行日時を確認
- クリックで結果を再表示
- ページリロードしても URL ハッシュで状態を復元

## アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│                    Web UI                        │
│              (Svelte + Vite)                     │
│    http://localhost:3001                         │
└─────────────┬───────────────────────────────────┘
              │ SSE / REST API
┌─────────────▼───────────────────────────────────┐
│               Express Server                     │
│            (src/server/app.ts)                    │
│  POST /api/run  GET /api/status/:id (SSE)       │
│  GET /api/workflows  GET /api/workflow/:id       │
│  GET /api/result/:id  GET /api/local-models      │
└─────────────┬───────────────────────────────────┘
              │ Temporal Client
┌─────────────▼───────────────────────────────────┐
│            Temporal Server                        │
│         (Workflow Orchestration)                  │
│    Retry, Timeout, Signal, Query, History        │
└─────────────┬───────────────────────────────────┘
              │ Activity Execution
┌─────────────▼───────────────────────────────────┐
│              Worker                               │
│         (src/worker.ts)                           │
│                                                   │
│  ┌──────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ Planner  │ │Task Designer │ │ Executor×N   │ │
│  │          │ │              │ │  → Reviewer×N │ │
│  └──────────┘ └──────────────┘ └──────────────┘ │
│  ┌──────────────────┐ ┌────────────────────────┐ │
│  │   Integrator     │ │ Integration Reviewer   │ │
│  └──────────────────┘ └────────────────────────┘ │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │          LLM Provider Registry              │ │
│  │  Claude Agent SDK │ Anthropic API │ Local   │ │
│  └─────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

## エージェント一覧

| エージェント | 役割 | 入力 | 出力 |
|---|---|---|---|
| **Planner** | プロンプトを DAG タスクに分解 | prompt | TaskPlan (tasks + planSummary + userIntent + qualityGuidelines) |
| **Task Designer** | DAG 妥当性検証 + タスクごとの実行ガイダンス設計 | plan + originalPrompt | TaskDesignResult (valid/issues/designedPlan with purpose, successCriteria, outputFormat) |
| **Executor** | 個別タスクを実行 (ツール使用可) | task + context + allowedTools | result + toolUsage |
| **Reviewer** | タスク結果の品質レビュー | result + toolUsage | passed/notes/revisedResult |
| **Integrator** | レビュー済みタスクを統合 | reviewedTasks + taskResultFiles | integratedResponse |
| **Integration Reviewer** | 最終 QA (5段階スコアリング) | integratedResponse + toolEvidence | passed/score/strengths/improvements/revisedResponse |

## ツール一覧

UI から Executor に許可するツールを選択できます:

| ツール | 説明 |
|---|---|
| Read | ファイル読み取り |
| Write | ファイル書き込み |
| Edit | ファイル編集 |
| Bash | シェルコマンド実行 |
| Glob | ファイルパターン検索 |
| Grep | ファイル内容検索 |
| WebFetch | URL からデータ取得 |
| WebSearch | Web 検索 |
| NotebookEdit | Jupyter ノートブック編集 |
| Task | サブタスク委譲 |
| ToolSearch | 利用可能ツール検索 |

## テスト

```bash
npm test
```

209 テスト:

- LLM 層 (callStructured / callRawText) のオプション・エラー処理・ツール証跡抽出
- LLM プロバイダー (ClaudeAgent / AnthropicApi / ProviderRegistry) のユニットテスト
- 全 Zod スキーマのバリデーション
- 全 7 アクティビティのユニットテスト (Planner, TaskDesigner, Executor, Reviewer, Integrator, IntegrationReviewer, ArtifactStore)
- Express API エンドポイント (supertest)
- ワークフロー統合テスト (DAG 並列実行、依存チェーン、リトライ、イベント記録)

## API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `POST` | `/api/run` | ワークフロー起動 (prompt, model, provider, agentConfig, allowedTools, retry 設定) |
| `GET` | `/api/workflows` | 履歴一覧 (直近50件、ステータス補完付き) |
| `GET` | `/api/workflow/:id` | ワークフロー詳細 (設定、状態、結果、失敗理由) |
| `GET` | `/api/status/:id` | SSE リアルタイムストリーミング |
| `GET` | `/api/result/:id` | 最終結果取得 |
| `GET` | `/api/local-models` | ローカル LLM のモデル一覧 |

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal Server のアドレス |
| `TEMPORAL_NAMESPACE` | `default` | Temporal の namespace |
| `CLAUDE_MODEL` | `claude-opus-4-6` | デフォルトモデル |
| `PORT` | `3001` | Express サーバーのポート |
| `CLAUDE_CONFIG_DIR` | `~/.config/claude` | Claude Code 認証ディレクトリ (Docker 用) |
| `ARTIFACT_DIR` | `/tmp/agentic` | アーティファクト保存先 (Docker: `/data/artifacts`) |
| `DEFAULT_AGENT_CONFIG` | — | エージェント別デフォルト設定 (JSON文字列) |
| `LOCAL_LLM_BASE_URL` | — | ローカル LLM の API エンドポイント |
| `LOCAL_LLM_MODEL` | `default` | ローカル LLM のモデル名 |
| `LOCAL_LLM_PROVIDER_NAME` | `local-llm` | ローカル LLM のプロバイダー名 |
| `LOCAL_LLM_API_KEY` | `local-llm` | ローカル LLM の API キー |
| `LOCAL_LLM_FALLBACK_MODEL` | — | ローカル LLM のフォールバックモデル |
| `ANTHROPIC_API_KEY` | — | Anthropic API 直接利用時のキー |

> `ANTHROPIC_API_KEY` は Claude Agent SDK 使用時は不要です。OAuth セッションを使用します。

## ライセンス

MIT
