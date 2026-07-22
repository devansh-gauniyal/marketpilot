// /api/chat — single-turn Q&A surface. Sends one user message to Gemini along
// with the workspace memory bundle and returns the reply.
//
// This is not the agent loop. It's a lightweight reactive surface for the
// Chat screen — "why did signups drop this week?", "summarize my last audit",
// etc. Streaming will be added later; today the response comes back in one
// chunk.

import { Router } from "express";
import { loadMemory, renderMemoryForPrompt } from "../lib/memory/load";
import { eventsStore } from "../lib/store";

export const chatRouter = Router();

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

chatRouter.post("/", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set on the backend." });
  }
  const message = typeof req.body?.message === "string" ? req.body.message : "";
  if (!message.trim()) {
    return res.status(400).json({ error: "message is required." });
  }

  const memory = loadMemory();
  const memoryText = renderMemoryForPrompt(memory);

  const systemPrompt = [
    "You are MarketPilot AI's reactive assistant. The user can ask anything about their workspace: recent audits, performance, drafts, agent activity, marketing strategy.",
    "",
    "Use the workspace memory below to answer. Be concise (3-6 sentences). When suggesting an action the user can take, mention which skill or tool would do it.",
    "",
    memoryText,
  ].join("\n");

  try {
    const r = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: systemPrompt }] },
          { role: "user", parts: [{ text: message }] },
        ],
        generationConfig: { temperature: 0.5 },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({
        error: `Gemini API error (${r.status}): ${text.slice(0, 200)}`,
      });
    }

    const data = (await r.json()) as Record<string, unknown>;
    const candidate = (data.candidates as Record<string, unknown>[])?.[0];
    const parts = (candidate?.content as Record<string, unknown> | undefined)?.parts as
      | { text?: string }[]
      | undefined;
    const reply = parts?.map((p) => p.text ?? "").join("").trim() || "(no reply)";

    eventsStore.append("chat_message", { userLen: message.length, replyLen: reply.length });

    res.json({ reply });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "unknown network error",
    });
  }
});
