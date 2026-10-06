type Evidence = { pageNo: number; text: string };

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function answerQuestion(question: string, evidence: Evidence[]): Promise<string> {
  const provider = process.env.LLM_PROVIDER ?? 'mock';
  if (provider === 'mock') {
    return `I found supporting text on ${[...new Set(evidence.map((item) => `page ${item.pageNo}`))].join(', ')}. Configure LLM_PROVIDER and LLM_API_KEY for a natural-language answer.`;
  }

  const isDeepSeek = provider === 'deepseek';
  const apiKey = isDeepSeek ? (process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY) : process.env.LLM_API_KEY;
  if (!apiKey) throw new Error(isDeepSeek ? 'DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek' : 'LLM_API_KEY is required when LLM_PROVIDER is not mock');
  const baseUrl = (isDeepSeek ? (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com') : (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = isDeepSeek ? (process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash') : (process.env.LLM_MODEL ?? 'gpt-4o-mini');
  const timeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 30_000);
  let response: Response;
  try {
    response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Answer only from the supplied document evidence. For overview questions such as "what is this document", summarize the evidence. If the evidence is insufficient, say so clearly. Do not invent citations or page numbers.' },
          { role: 'user', content: `Question: ${question}\n\nEvidence:\n${evidence.map((item, index) => `[Evidence ${index + 1}, page ${item.pageNo}] ${item.text}`).join('\n\n')}` }
        ]
      })
    }, timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`LLM request timed out after ${timeoutMs} ms`);
    throw error;
  }
  if (!response.ok) throw new Error(`LLM request failed with ${response.status}`);
  const payload = await response.json() as any;
  return String(payload.choices?.[0]?.message?.content ?? '').trim() || 'The document does not provide enough information to answer this question.';
}
