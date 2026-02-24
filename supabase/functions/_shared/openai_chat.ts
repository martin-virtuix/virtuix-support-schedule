export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OpenAiChatPayload = {
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
};

type RequestParams = {
  apiKey: string;
  modelCandidates: string[];
  messages: ChatMessage[];
  temperature?: number;
};

type RequestResult = {
  content: string;
  model: string;
  attempted_models: string[];
};

const DEFAULT_MODEL_CANDIDATES = [
  "gpt-4.1-mini",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4o",
];

function parseModelList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function buildModelCandidates(primaryModel: string | null | undefined, fallbackModels: string | null | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const add = (value: string | null | undefined) => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push(normalized);
  };

  add(primaryModel);
  parseModelList(fallbackModels).forEach(add);
  DEFAULT_MODEL_CANDIDATES.forEach(add);

  return ordered;
}

function parseOpenAiError(text: string): { code: string | null; type: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(text) as OpenAiChatPayload;
    return {
      code: typeof parsed.error?.code === "string" ? parsed.error.code : null,
      type: typeof parsed.error?.type === "string" ? parsed.error.type : null,
      message: typeof parsed.error?.message === "string" ? parsed.error.message : null,
    };
  } catch {
    return { code: null, type: null, message: null };
  }
}

function shouldTryNextModel(status: number, code: string | null, message: string | null): boolean {
  if (status === 404) return true;
  if (code === "model_not_found") return true;
  if (message && /does not exist|do not have access/i.test(message)) return true;
  return false;
}

export async function requestChatCompletionWithModelFallback(params: RequestParams): Promise<RequestResult> {
  const attemptedModels: string[] = [];

  for (let index = 0; index < params.modelCandidates.length; index += 1) {
    const model = params.modelCandidates[index];
    attemptedModels.push(model);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: params.temperature ?? 0.2,
        messages: params.messages,
      }),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      const parsedError = parseOpenAiError(bodyText);
      const canTryNext = shouldTryNextModel(response.status, parsedError.code, parsedError.message);
      const hasNextModel = index < params.modelCandidates.length - 1;
      if (canTryNext && hasNextModel) {
        continue;
      }
      throw new Error(`OpenAI request failed (${response.status}): ${bodyText}`);
    }

    let payload: OpenAiChatPayload;
    try {
      payload = JSON.parse(bodyText) as OpenAiChatPayload;
    } catch {
      throw new Error("OpenAI returned malformed JSON response.");
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`OpenAI returned an empty response for model ${model}.`);
    }

    const resolvedModel = typeof payload.model === "string" ? payload.model : model;
    return {
      content: content.trim(),
      model: resolvedModel,
      attempted_models: attemptedModels,
    };
  }

  throw new Error(`OpenAI request failed for all model candidates: ${params.modelCandidates.join(", ")}`);
}
