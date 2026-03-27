export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenAIClientOptions = {
  host: string;
  auth: string;
  timeout: number;
};

export class OpenAIClient {
  constructor(private readonly options: OpenAIClientOptions) {}

  async createChatCompletion(input: {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
  }): Promise<string> {
    const response = await this.request({
      ...input,
      stream: false
    });

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
    }

    return extractMessageText(payload.choices?.[0]?.message?.content);
  }

  async streamChatCompletion(
    input: {
      model: string;
      messages: ChatMessage[];
      temperature?: number;
    },
    onDelta: (chunk: string) => void | Promise<void>
  ): Promise<string> {
    const response = await this.request({
      ...input,
      stream: true
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(payload || `HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("streaming response body is empty");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payloadText = trimmed.slice(5).trim();

        if (payloadText === "[DONE]") {
          return fullText;
        }

        const payload = JSON.parse(payloadText) as {
          choices?: Array<{
            delta?: {
              content?: string | Array<{ type?: string; text?: string }>;
            };
          }>;
        };

        const text = extractMessageText(payload.choices?.[0]?.delta?.content);
        if (text) {
          fullText += text;
          await onDelta(text);
        }
      }
    }

    return fullText;
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      return await fetch(buildChatCompletionsUrl(this.options.host), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: normalizeAuthHeader(this.options.auth)
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildChatCompletionsUrl(host: string): string {
  const normalized = host.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function normalizeAuthHeader(auth: string): string {
  return auth.toLowerCase().startsWith("bearer ") ? auth : `Bearer ${auth}`;
}

function extractMessageText(
  content: string | Array<{ type?: string; text?: string }> | undefined
): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(part => part.text ?? "")
      .join("");
  }

  return "";
}
