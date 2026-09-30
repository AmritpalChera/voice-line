#!/usr/bin/env node
// Voice line channel for Claude Code: puts what the user says on a phone call into this session, and
// sends Claude's answers back to be spoken. Claude Code starts it over stdio.
//
// Inbound: long-polls the hub (/api/voice/channel/pull) — nothing listens on this machine.
// Outbound: reply → spoken on the live call; call_me → the hub rings the user.
// Permission relay: tool approvals are read out on the call; a spoken yes/no answers them.
// Auth: "connect this computer". With no token, the plugin makes one, sends only its hash with a pairing
// code, opens the approval page in the browser, and waits; once the signed-in user approves, it keeps the
// token in its data folder. If the hub ever rejects it (revoked on the dashboard), it pairs again.
// VOICE_LINE_TOKEN in the environment overrides all of this.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { execFileSync, spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const HUB = process.env.VOICE_HUB_URL ?? "https://screwaivoice.com"
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".voice-line")
const TOKEN_FILE = join(DATA_DIR, "token")
let TOKEN = process.env.VOICE_LINE_TOKEN || readToken()

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim()
  } catch {
    return ""
  }
}
const log = (...a) => console.error("[voice-line]", ...a) // stdout belongs to MCP

const INSTRUCTIONS = `Messages from voice-line with kind="setup" come from the plugin, not from a caller: show them to the user as they are, and don't use the reply tool for them.
The user is talking to you on a phone call. What they say arrives as <channel source="voice-line" msg_id="...">, transcribed from speech, so expect small transcription errors.
Answer every message with the reply tool, in one to three short spoken sentences: no markdown, lists, code or URLs.
Use whatever tools you have (browser, connectors, files) to do what they ask.
If something will take more than about 30 seconds, reply first with a short acknowledgement ("On it, I'll call you when it's done"), do the work, then call call_me with the result. Use call_me as well if you need a decision from them after the call has ended.`

let latestMsgId = null // the phone conversation is one sequential thread: replies go to the newest message
let pendingPermission = null // request_id of a tool approval read out on the call

/** Only the session started with the channel flag can deliver calls. A plain session with the plugin
 *  enabled must not pull messages (it would take them and drop them), so it stays idle. */
function inChannelSession() {
  if (process.env.VOICE_LINE_FORCE_CHANNEL) return true
  try {
    const args = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], { encoding: "utf8" })
    return /--(dangerously-load-development-)?channels\b.*voice-line/.test(args)
  } catch {
    return true // can't tell (no ps, e.g. Windows): behave as before
  }
}

class Unauthorized extends Error {}

async function hub(path, init = {}) {
  const res = await fetch(HUB + path, {
    ...init,
    headers: { "x-voice-token": TOKEN, "content-type": "application/json", ...(init.headers ?? {}) },
  })
  const body = await res.text()
  if (res.status === 401) throw new Unauthorized("token rejected")
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${body.slice(0, 200)}`)
  return body ? JSON.parse(body) : {}
}

const mcp = new Server(
  { name: "voice-line", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Say something to the user on the phone call. One to three short spoken sentences.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    {
      name: "call_me",
      description: "Phone the user (after a long task, or when you need a decision and the call has ended).",
      inputSchema: { type: "object", properties: { text: { type: "string", description: "What to tell them first." } }, required: ["text"] },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = String(req.params.arguments?.text ?? "").trim()
  if (!text) throw new Error("text is required")
  if (req.params.name === "reply") {
    if (!latestMsgId) {
      await hub("/api/voice/channel/call", { method: "POST", body: JSON.stringify({ text }) })
      return { content: [{ type: "text", text: "No call in progress, so I rang the user with it." }] }
    }
    const r = await hub("/api/voice/channel/reply", {
      method: "POST",
      body: JSON.stringify({ in_reply_to: latestMsgId, text }),
    })
    return { content: [{ type: "text", text: r.delivered === "callback" ? "The call had moved on; the user is being rung back with it." : "said" }] }
  }
  if (req.params.name === "call_me") {
    await hub("/api/voice/channel/call", { method: "POST", body: JSON.stringify({ text }) })
    return { content: [{ type: "text", text: "calling" }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// Tool approvals: read the request out on the call; the next spoken yes/no answers it.
mcp.setNotificationHandler(
  z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    pendingPermission = params.request_id
    const ask = `I need your OK to ${params.description.replace(/\.$/, "")}. Should I go ahead?`
    try {
      if (latestMsgId) {
        await hub("/api/voice/channel/reply", { method: "POST", body: JSON.stringify({ in_reply_to: latestMsgId, text: ask }) })
      } else {
        await hub("/api/voice/channel/call", { method: "POST", body: JSON.stringify({ text: ask }) })
      }
    } catch (err) {
      log("could not relay permission request", err.message)
    }
  },
)

const YES = /^\s*(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|approve|approved)\b/i
const NO = /^\s*(no|nope|don'?t|stop|deny|cancel)\b/i

async function deliver(m) {
  latestMsgId = m.id
  if (pendingPermission && (YES.test(m.text) || NO.test(m.text))) {
    const behavior = YES.test(m.text) ? "allow" : "deny"
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: pendingPermission, behavior },
    })
    log("permission", pendingPermission, behavior)
    pendingPermission = null
    return
  }
  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: m.text, meta: { msg_id: m.id } },
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tellUser(text) {
  await mcp.notification({ method: "notifications/claude/channel", params: { content: text, meta: { kind: "setup" } } })
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]]
  // a missing opener (no xdg-open, say) is reported as an 'error' event, which would crash us if unhandled;
  // the link is also shown in the session, so just carry on
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

/** Link this computer to an account: nothing to copy, the user just approves it in the browser. */
async function pair() {
  for (;;) {
    const token = `vl_${randomBytes(24).toString("base64url")}`
    const tokenHash = createHash("sha256").update(token).digest("hex")
    const res = await fetch(`${HUB}/api/voice/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token_hash: tokenHash, label: `${hostname()} (Claude Code)` }),
    })
    if (!res.ok) {
      log("pairing start failed:", res.status)
      await sleep(10_000)
      continue
    }
    const { code, url } = await res.json()
    openInBrowser(url)
    await tellUser(
      `Voice Line needs to be connected to your account. A browser tab should have opened; if not, open ${url} and click "Connect this computer". The code is ${code}.`,
    )
    for (;;) {
      await sleep(3000)
      const s = await fetch(`${HUB}/api/voice/pair/status?code=${encodeURIComponent(code)}&token_hash=${tokenHash}`)
        .then((r) => r.json())
        .catch(() => ({}))
      if (s.approved) {
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 })
        TOKEN = token
        await tellUser("Voice Line is connected. You can call your agent line now; keep this session open.")
        return
      }
      if (s.expired) break // start over with a fresh code
    }
  }
}

async function pollForever() {
  for (;;) {
    if (!TOKEN) await pair()
    try {
      const { messages = [] } = await hub("/api/voice/channel/pull")
      for (const m of messages) await deliver(m)
    } catch (err) {
      if (err instanceof Unauthorized && !process.env.VOICE_LINE_TOKEN) {
        log("token rejected (revoked?); pairing again")
        rmSync(TOKEN_FILE, { force: true })
        TOKEN = ""
        continue
      }
      log("pull failed:", err.message)
      await sleep(3000)
    }
  }
}

await mcp.connect(new StdioServerTransport())
if (!inChannelSession()) {
  log("not a channel session (start Claude Code with the channel flag to take calls); staying idle")
} else pollForever()
