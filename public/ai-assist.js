// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Bring your own AI key (Settings > Ask AI): a question goes straight from this phone to the OpenAI-compatible
// endpoint you set there, never through A2B's own server, and the key is kept on this phone only (core.js local).
// That one shape covers OpenAI, Groq, OpenRouter, a local Ollama, and most others.
// buildRequest is pure, so it runs in tests without a network call; askAI does the actual fetch.

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_MODEL = 'gpt-4o-mini';
const TIMEOUT_MS = 20_000;
const MAX_TOKENS = 400;

// So "https://api.openai.com/v1" and ".../v1/" both work.
const normalizeBaseUrl = (url) => (url?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

export function buildRequest({ baseUrl, apiKey, model, question, system } = {}) {
  if (!apiKey?.trim()) throw new Error('Set your AI API key in Settings first.');
  if (!question?.trim()) throw new Error('Ask something first.');
  return {
    url: `${normalizeBaseUrl(baseUrl)}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.trim()}` },
      body: JSON.stringify({
        model: model?.trim() || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: question.trim() }],
      }),
    },
  };
}

export async function askAI(opts) {
  const { url, init } = buildRequest(opts);
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error("Couldn't reach that AI provider. Check the base URL and your connection.");
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('That API key was rejected.');
    const body = await res.text().catch(() => '');
    throw new Error(`The AI provider said: ${body.slice(0, 140) || res.status}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('The AI gave an empty answer.');
  return text;
}
