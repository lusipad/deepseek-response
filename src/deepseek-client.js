export class DeepSeekClient {
  constructor({ apiKey, baseUrl, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  async createChatCompletion(payload) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new DeepSeekError(await readErrorMessage(response), response.status);
    }

    return response.json();
  }

  async streamChatCompletion(payload) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...payload, stream: true })
    });

    if (!response.ok) {
      throw new DeepSeekError(await readErrorMessage(response), response.status);
    }

    if (!response.body) {
      throw new DeepSeekError("DeepSeek response did not include a stream body.", 502);
    }

    return response.body;
  }

  headers() {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`
    };
  }
}

export class DeepSeekError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
  }
}

function normalizeBaseUrl(baseUrl) {
  return (baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text) {
    return `DeepSeek request failed with status ${response.status}.`;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed.error?.message ?? text;
  } catch {
    return text;
  }
}
