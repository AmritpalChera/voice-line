#!/usr/bin/env node
// Voice line channel for Claude Code: puts what the user says on a phone call into this session, and
// sends Claude's answers back to be spoken. Claude Code starts it over stdio.
//
// Inbound: long-polls the hub (/api/voice/channel/pull) — nothing listens on this machine.
// Outbound: reply → spoken on the live call; call_me → the hub rings the user.
// Permission relay: tool approvals are read out on the call; a spoken yes/no answers them.
// Auth: your personal voice-line token (Claude Code asks for it when you enable the plugin). The hub only
// hands this plugin messages from calls made by the phone number the token belongs to.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

const HUB = process.env.VOICE_HUB_URL ?? "https://labs-eta-six.vercel.app"
const TOKEN = process.env.VOICE_LINE_TOKEN ?? ""
const log = (...a) => console.error("[voice-line]", ...a) // stdout belongs to MCP

const INSTRUCTIONS = `The user is talking to you on a phone call. What they say arrives as <channel source="voice-line" msg_id="...">, transcribed from speech, so expect small transcription errors.
Answer every message with the reply tool, in one to three short spoken sentences: no markdown, lists, code or URLs.
Use whatever tools you have (browser, connectors, files) to do what they ask.
If something will take more than about 30 seconds, reply first with a short acknowledgement ("On it, I'll call you when it's done"), do the work, then call call_me with the result. Use call_me as well if you need a decision from them after the call has ended.`

let latestMsgId = null // the phone conversation is one sequential thread: replies go to the newest message
let pendingPermission = null // request_id of a tool approval read out on the call

async function hub(path, init = {}) {
  const res = await fetch(HUB + path, {
    ...init,
    headers: { "x-voice-token": TOKEN, "content-type": "application/json", ...(init.headers ?? {}) },
  })
  const body = await res.text()
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

async function pollForever() {
  for (;;) {
    try {
      const { messages = [] } = await hub("/api/voice/channel/pull")
      for (const m of messages) await deliver(m)
    } catch (err) {
      log("pull failed:", err.message)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

await mcp.connect(new StdioServerTransport())
if (!TOKEN) log("no voice-line token set; enable the plugin again and enter your token")
pollForever()
