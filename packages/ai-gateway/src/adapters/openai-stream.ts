import type { ToolCallRequest } from '../adapter';

/**
 * PR A (smart Copilot, D-605) — READING A STREAMED CHAT ANSWER.
 *
 * The provider sends server-sent events: `data: {json}` lines, one chunk of
 * the answer each, ending with `data: [DONE]`. Text arrives as
 * `choices[0].delta.content`; a tool call arrives in pieces under
 * `choices[0].delta.tool_calls[i]` (its id and name first, its JSON arguments
 * a few characters at a time), keyed by `index`; the usage comes in a last
 * chunk with no choices when `stream_options.include_usage` is set.
 *
 * PURE AND INCREMENTAL: `push` takes whatever text arrived (a chunk can end in
 * the middle of a line), hands complete text pieces to `onDelta` at once, and
 * `finish` returns what the whole answer was. No I/O, so a test feeds it a
 * recorded stream.
 */
export interface StreamedAnswer {
  readonly text: string;
  readonly toolCalls: readonly ToolCallRequest[];
  readonly finishReason: string | null;
  readonly refusal: boolean;
  readonly model: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

export class ChatStreamReader {
  readonly #onDelta: ((text: string) => void) | undefined;
  #buffer = '';
  #text = '';
  #finishReason: string | null = null;
  #refusal = false;
  #model: string | null = null;
  #promptTokens = 0;
  #completionTokens = 0;
  readonly #calls = new Map<number, PartialCall>();

  constructor(onDelta?: (text: string) => void) {
    this.#onDelta = onDelta;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#line(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  finish(): StreamedAnswer {
    if (this.#buffer.trim()) this.#line(this.#buffer.replace(/\r$/, ''));
    this.#buffer = '';
    return {
      text: this.#text,
      toolCalls: [...this.#calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.name !== ''),
      finishReason: this.#finishReason,
      refusal: this.#refusal,
      model: this.#model,
      promptTokens: this.#promptTokens,
      completionTokens: this.#completionTokens,
    };
  }

  #line(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') return;
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      return; // A malformed line is skipped; the shape check at the end decides.
    }
    if (typeof event.model === 'string') this.#model = event.model;
    if (event.usage) {
      this.#promptTokens = count(event.usage.prompt_tokens);
      this.#completionTokens = count(event.usage.completion_tokens);
    }
    const choice = event.choices?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string') this.#finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.refusal === 'string' && delta.refusal !== '') this.#refusal = true;
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.#text += delta.content;
      this.#onDelta?.(delta.content);
    }
    for (const piece of delta.tool_calls ?? []) {
      const index = typeof piece.index === 'number' ? piece.index : 0;
      const call = this.#calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof piece.id === 'string' && piece.id) call.id = piece.id;
      if (typeof piece.function?.name === 'string') call.name += piece.function.name;
      if (typeof piece.function?.arguments === 'string') call.arguments += piece.function.arguments;
      this.#calls.set(index, call);
    }
  }
}

interface StreamEvent {
  model?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  choices?: {
    finish_reason?: unknown;
    delta?: {
      content?: unknown;
      refusal?: unknown;
      tool_calls?: {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
  }[];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
