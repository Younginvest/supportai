/**
 * The only place that talks to an AI model. Everything else calls provider.complete(),
 * so the model can be swapped without touching the rest of the product.
 *
 * IMPORTANT: the build sandbox had no internet, so AnthropicProvider has NOT been run against the
 * real API from here. It follows the documented Messages API; test it once with a real key.
 */
let injected = null;

export function setProvider(p) { injected = p; } // used by tests

export class AnthropicProvider {
  constructor({ apiKey, model }) { this.apiKey = apiKey; this.model = model; }

  async complete({ system, user, maxTokens = 700 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('AI service returned status ' + res.status);
      const data = await res.json();
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getProvider() {
  if (injected) return injected;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new AnthropicProvider({ apiKey, model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001' });
}
