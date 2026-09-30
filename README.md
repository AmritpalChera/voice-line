# Voice Line

Call a phone number and talk to the Claude Code session running on your computer. Claude answers with
everything that session can use: your browser (Claude in Chrome), your claude.ai connectors, local MCP
servers and files. Long tasks keep running after you hang up, and Claude calls you back when they're done.

## Install

Sign up at [screwaivoice.com](https://screwaivoice.com), then in Claude Code:

```
/plugin marketplace add AmritpalChera/voice-line
/plugin install voice-line@voice-line
```

The first time a session starts with the plugin, it opens screwaivoice.com in your browser: click
"Connect this computer". There's nothing to copy. To disconnect a computer, revoke it on the dashboard;
the plugin asks to connect again next time.

## Start a session you can call

Channels are a Claude Code research preview. Until Voice Line is on Anthropic's channel allowlist,
start the session with the development flag (Claude Code shows a warning first):

```
claude --dangerously-load-development-channels plugin:voice-line@voice-line
```

Keep that terminal open, then call the line from the phone number your token belongs to.

## What happens on a call

- What you say reaches the session as a channel message; Claude's answer is spoken back to you.
- Claude asks for approval on the call before anything that needs it (shell commands, file edits,
  form submissions). Say yes or no. Leave the session in its normal ask-first mode so these reach you.
- If a task takes a while, Claude says so, carries on after you hang up, and phones you with the result.

## Develop

`src/server.mjs` is the channel server. `npm install && npm run build` bundles it into
`plugins/voice-line/server.mjs`, the file the plugin runs, so installs need no `npm install`.
