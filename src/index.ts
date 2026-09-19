import { define } from "@opencode-ai/plugin/v2/promise"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"

type GateOptions = {
  enabled?: boolean
  model?: string
  isWorkThreshold?: number
  dimensionThreshold?: number
  timeoutMs?: number
  minChars?: number
  apiKeyEnv?: string
  apiKeyFile?: string
  logFile?: string
}

type Scores = {
  is_work_request: number
  ambiguous: number
  missing_user_info: number
  scope_unclear: number
}

type Dimension = "ambiguous" | "missing_user_info" | "scope_unclear"

type Decision = {
  confirm: boolean
  reasons: Dimension[]
  scores: Scores
}

type AiContentPart = { type?: string; text?: string }
type AiMessage = { id?: string; role?: string; content?: AiContentPart[] }

type ContextHookEvent = {
  sessionID?: string
  messages?: AiMessage[]
  system: Array<{ type: "text"; text: string }>
}

type Ctx = {
  options: Record<string, unknown>
  location?: { directory?: string; project?: { canonical?: string } }
  session: {
    hook(
      name: "context",
      callback: (event: ContextHookEvent) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<unknown>
  }
}

const DIMENSIONS: readonly Dimension[] = ["ambiguous", "missing_user_info", "scope_unclear"]

const DIMENSION_LABELS: Record<Dimension, string> = {
  ambiguous: "the request has more than one possible interpretation",
  missing_user_info: "information only the user can provide is missing (preferences, priorities, constraints, targets)",
  scope_unclear: "the scope is unclear (which files or areas are affected, and what done means)",
}

const ACK_PATTERN =
  /^(ok(ay)?|yes|yep|no|nope|thanks?|thank you|go ahead|do it|はい|うん|了解(です)?|りょうかい|おk|ありがと(う)?|ありがとうございます|続けて|進めて|お願い(します)?|よろしく(お願いします)?)[。、.!！?？\s]*$/iu

const messageText = (message: AiMessage): string =>
  (message.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()

const lastUserMessage = (messages: AiMessage[]): { key: string; text: string } | undefined => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== "user") continue
    const text = messageText(message)
    if (!text) continue
    return { key: message.id ?? `text:${text.slice(0, 120)}`, text }
  }
  return undefined
}

export default define({
  id: "intent-gate",
  async setup(rawCtx: unknown) {
    const ctx = rawCtx as Ctx
    const options = ctx.options as GateOptions
    const enabled = options.enabled !== false && process.env.TYPESAFE_INTENT_GATE !== "off"
    const model = options.model ?? "jev-latest"
    const isWorkThreshold = options.isWorkThreshold ?? 0.5
    const dimensionThreshold = options.dimensionThreshold ?? 0.75
    const timeoutMs = options.timeoutMs ?? 2500
    const minChars = options.minChars ?? 2
    const apiKeyEnv = options.apiKeyEnv ?? "TYPESAFE_API_KEY"
    const apiKeyFile = options.apiKeyFile ?? join(homedir(), ".config/opencode/typesafe/api_key")
    const logFile = options.logFile ?? join(homedir(), ".config/opencode/intent-gate/decisions.jsonl")

    const judged = new Map<string, Decision | null>()
    const remember = (key: string, decision: Decision | null) => {
      judged.set(key, decision)
      if (judged.size > 100) {
        const oldest = judged.keys().next().value
        if (oldest !== undefined) judged.delete(oldest)
      }
    }

    let apiKey: string | undefined
    let warnedNoKey = false
    let consecutiveFailures = 0
    let disabledUntil = 0

    await mkdir(dirname(logFile), { recursive: true }).catch(() => {})
    const configuredKey = process.env[apiKeyEnv]?.trim()
    const fileKey = (await readFile(apiKeyFile, "utf8").catch(() => "")).trim()
    const keyAvailable = Boolean(configuredKey || fileKey)
    if (enabled && !keyAvailable) {
      console.warn(
        `[intent-gate] ${apiKeyEnv} is not set and ${apiKeyFile} is missing or empty; gate stays inactive`,
      )
    }

    const log = (entry: Record<string, unknown>) => {
      void appendFile(logFile, JSON.stringify(entry) + "\n").catch(() => {})
    }

    const resolveKey = async (): Promise<string | undefined> => {
      if (apiKey) return apiKey
      apiKey = process.env[apiKeyEnv]?.trim() || (await readFile(apiKeyFile, "utf8").catch(() => "")).trim() || undefined
      if (!apiKey && !warnedNoKey) {
        warnedNoKey = true
        console.warn(`[intent-gate] no API key (${apiKeyEnv} or ${apiKeyFile}); gate disabled`)
      }
      return apiKey
    }

    const judge = async (text: string) => {
      const started = Date.now()
      if (Date.now() < disabledUntil) return { latencyMs: 0, error: "circuit-open" }
      const key = await resolveKey()
      if (!key) return { latencyMs: 0, error: "no-api-key" }

      try {
        const response = await fetch(TYPESAFE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            state: {
              message: text,
              project: ctx.location?.project?.canonical ?? ctx.location?.directory ?? "unknown",
              note: "The message may be written in Japanese. Judge its meaning, not its language.",
            },
            model,
            questions: {
              is_work_request: {
                type: "noul",
                instructions:
                  "The message asks for work on the codebase or environment (implementation, modification, investigation, or running commands). It is not small talk, a status question, or a request for an explanation.",
              },
              ambiguous: {
                type: "noul",
                instructions: "The message has more than one plausible interpretation for what the agent should do.",
                criteria: { true: "Multiple reasonable readings of what to do", false: "One obvious reading" },
              },
              missing_user_info: {
                type: "noul",
                instructions:
                  "Doing this correctly requires information that only the user can provide (preferences, priorities, constraints, or targets that are not stated and cannot be discovered from the codebase).",
              },
              scope_unclear: {
                type: "noul",
                instructions:
                  "The scope of the work is unclear: which files, components, or areas are affected, and what counts as done.",
                criteria: {
                  true: "Scope or completion criteria are undefined",
                  false: "Scope and completion criteria are clear",
                },
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!response.ok) {
          consecutiveFailures += 1
          if (consecutiveFailures >= 3) disabledUntil = Date.now() + 5 * 60_000
          return { latencyMs: Date.now() - started, error: `http-${response.status}` }
        }

        const body = (await response.json()) as { answers?: Record<string, { noul?: number }> }
        const score = (id: keyof Scores): number => {
          const value = body.answers?.[id]?.noul
          return typeof value === "number" ? value : 0
        }
        const scores: Scores = {
          is_work_request: score("is_work_request"),
          ambiguous: score("ambiguous"),
          missing_user_info: score("missing_user_info"),
          scope_unclear: score("scope_unclear"),
        }
        const reasons = DIMENSIONS.filter((dimension) => scores[dimension] >= dimensionThreshold)
        const confirm = scores.is_work_request >= isWorkThreshold && reasons.length > 0
        consecutiveFailures = 0
        return { decision: { confirm, reasons, scores } satisfies Decision, latencyMs: Date.now() - started }
      } catch (error) {
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) disabledUntil = Date.now() + 5 * 60_000
        return { latencyMs: Date.now() - started, error: error instanceof Error ? error.name : "fetch-failed" }
      }
    }

    await ctx.session.hook("context", async (event) => {
      try {
        const latest = lastUserMessage(event.messages ?? [])
        if (!latest || !enabled) return
        const { key, text } = latest
        if (text.length < minChars || text.startsWith("/") || ACK_PATTERN.test(text)) return

        if (!judged.has(key)) {
          const { decision, latencyMs, error } = await judge(text)
          if (error || !decision) {
            remember(key, null)
            log({ ts: new Date().toISOString(), event: "skipped", error, latencyMs, preview: text.slice(0, 120) })
            return
          }
          remember(key, decision)
          log({
            ts: new Date().toISOString(),
            event: decision.confirm ? "gate" : "pass",
            scores: decision.scores,
            reasons: decision.reasons,
            latencyMs,
            preview: text.slice(0, 200),
          })
        }

        const decision = judged.get(key)
        if (!decision?.confirm) return
        const details = decision.reasons
          .map((dimension) => `${dimension}=${decision.scores[dimension].toFixed(2)}`)
          .join(", ")
        event.system.push({
          type: "text",
          text: [
            "[Intent gate] An automated pre-check flagged the latest user request as underspecified:",
            `- ${decision.reasons.map((dimension) => DIMENSION_LABELS[dimension]).join("; ")} (${details})`,
            "Before calling any tool or starting investigation or implementation, ask the user up to 3 short clarifying questions in the user's language that resolve these points.",
            "State the interpretation and assumptions you would otherwise proceed with, then wait for the user's answer.",
            "Do not start tool calls in this turn.",
          ].join("\n"),
        })
      } catch (error) {
        log({
          ts: new Date().toISOString(),
          event: "gate-error",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      }
    })

    log({ ts: new Date().toISOString(), event: "setup", enabled, keyAvailable, model, revision: 5 })
  },
})
