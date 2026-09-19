# opencode-intent-gate

A [TypeSafe Jev](https://docs.typesafe.ai/) powered plugin for [OpenCode](https://opencode.ai) that makes the agent confirm intent before diving into underspecified requests.

Agents love to silently start digging. When a request is vague ("just fix it somehow"), they pick an interpretation and run with it — investigating, editing, sometimes wrecking things. `opencode-intent-gate` inserts a judgment step before the turn starts: if the request looks underspecified, it injects a system directive telling the agent to ask 1-3 clarifying questions first instead of calling tools.

## How it works

```
user message
  → session hook "context" (right before model dispatch)
      → judge the latest user message with Jev (4 noul questions, 1 request)
          is_work_request / ambiguous / missing_user_info / scope_unclear
      → plain-code thresholds decide: gate or pass
  → if gated: push a directive into the system prompt
      "ask before acting; do not start tool calls this turn"
```

The decision is made from calibrated probabilities, not vibes: Jev returns `noul` scores and the thresholds are ordinary code constants you can tune. Verdicts are cached per message, so each user message costs one request of roughly 500 tokens (~0.5s, ~$0.00002).

## Measured behavior (Japanese requests)

| message | verdict |
|---|---|
| いい感じに直しといて | **gate** (ambiguous 0.81 / scope 0.97) |
| app/main.go のビルドエラーを直して | pass |
| これってどういう意味？ | pass (not a work request) |
| 予想ロジックを改善して。あとで見るから、いい感じに。 | **gate** |
| tmp/... を読んで要約して | pass |
| 掃除は今して | pass (specific follow-up) |

## Requirements

- OpenCode V2 (tested on `opencode2` `0.0.0-beta-17963`)
- A TypeSafe API key: sign in at <https://console.typesafe.ai> and issue one (a trial credit is included)

> **Beta note:** this plugin judges from the `context` hook (which runs before every model dispatch) instead of the `prompt` hook, so it also works on OpenCode V2 betas where the prompt hook is missing (e.g. `beta-17963`; `beta-19271` implements it). Tested on `beta-19271`.

## Install

Clone and symlink it into your global plugins directory:

```sh
git clone https://github.com/hoshinodis/opencode-intent-gate ~/app/opencode-intent-gate
ln -s ~/app/opencode-intent-gate ~/.config/opencode/plugins/opencode-intent-gate
```

Provide the API key to the process that runs the OpenCode service:

```sh
export TYPESAFE_API_KEY=...
```

or drop the key into `~/.config/opencode/typesafe/api_key`.

## Options

Options can be passed where the plugin is registered; defaults shown below.

| option | default | meaning |
|---|---|---|
| `enabled` | `true` | also disabled with `TYPESAFE_INTENT_GATE=off` |
| `model` | `jev-latest` | pin e.g. `jev-1.13.0` for reproducibility |
| `isWorkThreshold` | `0.5` | minimum `is_work_request` score to consider gating |
| `dimensionThreshold` | `0.75` | any ambiguity dimension at or above this gates |
| `timeoutMs` | `2500` | request timeout; on timeout the gate is skipped (fail-open) |
| `minChars` | `2` | skip messages shorter than this |
| `apiKeyEnv` / `apiKeyFile` | `TYPESAFE_API_KEY` / `~/.config/opencode/typesafe/api_key` | key lookup order |
| `logFile` | `~/.config/opencode/intent-gate/decisions.jsonl` | JSONL decision log |

## Safety

- **fail-open**: API errors and timeouts never block the prompt; after 3 consecutive failures the gate pauses for 5 minutes
- acknowledgements (`ok`, `はい`, `thanks`, ...) and slash commands are skipped
- the gate is a system directive, not a hard block. Pair it with tool permissions if you want enforcement.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT. Not affiliated with TypeSafe or OpenCode.

---

### 日本語

曖昧な依頼でコーディングエージェントが勝手に走り出すのを防ぐ、TypeSafe Jev 製の OpenCode プラグイン。モデル送信直前の `context` フックで最新のユーザーメッセージを4つの `noul` 質問（作業依頼か / 曖昧か / ユーザーしか知らない情報が必要か / スコープ不明か）で判定し、「確認すべき」と判定されたときだけ「ツールを使う前に質問しろ」という指示を system プロンプトに注入します。判定は確率スコアとコード側の閾値で決まり、失敗時は素通し（fail-open）。
