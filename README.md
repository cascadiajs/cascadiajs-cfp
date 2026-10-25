# CascadiaJS 2027 Call for Presenters

Submit a talk to [CascadiaJS 2027](https://cascadiajs.com/2027) from your AI agent. Connect your agent to our MCP server, sign in with your email, and it walks you through your profile, your talk and your 2-minute video.

- **Conference:** June 7-8, 2027, in Seattle, WA
- **Talks:** 25 minutes
- **Submissions:** a 2-minute video describing your talk idea
- **The CFP closes:** January 10, 2027

Full details, including the topics we're looking for and speaker perks, are at [cfp.cascadiajs.com](https://cfp.cascadiajs.com).

## Connect your agent

The MCP server is at:

```
https://cfp.cascadiajs.com/mcp
```

**Claude Code:** run this in your terminal:

```bash
claude mcp add --transport http cascadiajs-cfp https://cfp.cascadiajs.com/mcp
```

**Claude (web and desktop):** open **Settings → Connectors**, choose **Add custom connector**, name it `CascadiaJS CFP`, and paste the server URL.

**Cursor:** add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cascadiajs-cfp": {
      "url": "https://cfp.cascadiajs.com/mcp"
    }
  }
}
```

**VS Code:** add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "cascadiajs-cfp": {
      "type": "http",
      "url": "https://cfp.cascadiajs.com/mcp"
    }
  }
}
```

**Other agents:** any MCP client that supports remote servers over Streamable HTTP and OAuth sign-in can connect with the URL above.

## Sign in

The first time your agent connects, it opens a sign-in page in your browser:

1. Enter your email address.
2. Enter the one-time code we email you.
3. Approve your agent's access.

That's it. You only sign in once, and your agent keeps you signed in. There's no password or API key to copy around. We use your email for your CFP profile and to contact you about your talks.

## Submit a talk

Ask your agent:

```
Help me submit a talk to the CascadiaJS 2027 CFP.
```

It takes you through three steps:

1. **Your profile** (first time only): your name, location, social links, how you heard about the CFP, whether your company can cover travel, and confirmation that you can speak on June 7 or 8.
2. **Your talk:** a title (no colons, please), a description of fewer than 280 characters, and the topics it covers. Your agent can help you draft these, and you can edit them before submitting.
3. **Your video:** record your 2-minute video right there, or give a public link if you've already recorded it.

Submit one talk at a time. You can submit as many as you like. To see what you've submitted and whether each video went through, ask your agent:

```
What have I submitted to the CascadiaJS 2027 CFP?
```

In agents that support interactive apps, such as Claude, each step appears as a form in the chat. Other agents ask you for the same details in the conversation.

## Recording your video

When you choose to record:

1. Allow access to your camera and microphone.
2. Click **Start recording**. Recording stops automatically at 2:00, or click **Stop** sooner.
3. Watch it back, then click **Use this video** or **Record again**.
4. Keep the window open until the upload finishes.

Your video isn't made public: only people with the link can watch it, like an unlisted YouTube video.

If the recorder doesn't appear, or your agent blocks the camera, your agent gives you a link to record the video in your browser instead.

**What to say in your 2 minutes:** this isn't a mini-talk, just describe your idea informally.
- Introduce yourself: name, company, role.
- Tell us what your talk is about, big picture.
- Explain why it's exciting, with details (technologies, techniques).

If you'd rather record it yourself, upload it somewhere public but unlisted, such as YouTube (unlisted), Dropbox or your own site. Check the link works in a private browser window first: we can't consider videos we can't reach.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| The sign-in page doesn't open | Make sure you added the exact URL `https://cfp.cascadiajs.com/mcp`, then reconnect the server in your agent |
| Your agent says you need to sign in again | Reconnect or re-authenticate the server in your agent's settings |
| Your agent asks for details in chat instead of showing a form | Your agent doesn't support interactive forms; answer in the chat instead |
| The camera doesn't start | Allow camera and microphone access when your browser asks, or use the recording link your agent gives you |
| Your agent asks you to complete your profile first | Ask it to set up your CascadiaJS CFP profile, then submit your talk |

## Questions

Email us at [info@cascadiajs.com](mailto:info@cascadiajs.com). If an AI agent doesn't work for you, email us and we'll help you submit.

---

Running or developing this server? See [SETUP.md](SETUP.md).
