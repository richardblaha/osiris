import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@osiris/shared-core';
import type { LmChatRequest, LmMessage, LmModelBridge, LmToolSpec } from './bridge.js';

const log = createLogger('lm-proxy');

interface OpenAiChatBody {
  model?: string;
  messages?: { role: string; content?: unknown; tool_call_id?: string }[];
  tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
  stream?: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function toLmMessages(raw: OpenAiChatBody['messages'] = []): LmMessage[] {
  return raw.map((m) => ({
    role: (['system', 'user', 'assistant', 'tool'].includes(m.role)
      ? m.role
      : 'user') as LmMessage['role'],
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
    toolCallId: m.tool_call_id,
  }));
}

function toLmTools(raw: OpenAiChatBody['tools']): LmToolSpec[] | undefined {
  if (!raw?.length) return undefined;
  return raw
    .map((t) => t.function)
    .filter((f): f is NonNullable<typeof f> => Boolean(f?.name))
    .map((f) => ({
      name: f.name!,
      description: f.description ?? '',
      parameters: f.parameters ?? {},
    }));
}

function sse(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const CHUNK = (delta: unknown, finish: string | null = null): unknown => ({
  id: 'lmproxy',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/**
 * An OpenAI-compatible request handler backed by an editor LM bridge. Mount it on
 * a plain `node:http` server; `@osiris/agent-core`'s `OpenAiCompatibleAdapter`
 * (pointed at `<origin>/v1`) talks to it unchanged.
 *
 * Routes: `GET /v1/models`, `POST /v1/chat/completions` (stream + non-stream).
 */
export function createLmProxyHandler(bridge: LmModelBridge) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? '').split('?')[0];
    try {
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const models = await bridge.listModels();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: models.map((m) => ({ id: m.id, object: 'model', owned_by: m.vendor })),
          }),
        );
        return;
      }

      if (
        req.method === 'POST' &&
        (url === '/v1/chat/completions' || url === '/chat/completions')
      ) {
        const body = JSON.parse((await readBody(req)) || '{}') as OpenAiChatBody;
        const request: LmChatRequest = {
          model: body.model ?? '',
          messages: toLmMessages(body.messages),
          tools: toLmTools(body.tools),
        };
        const stream = body.stream !== false;

        if (stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
        }

        let text = '';
        const toolCalls: { id: string; name: string; args: string }[] = [];
        let finish = 'stop';

        for await (const chunk of bridge.chat(request)) {
          if (chunk.type === 'text') {
            text += chunk.text;
            if (stream) sse(res, CHUNK({ content: chunk.text }));
          } else if (chunk.type === 'tool-call') {
            const args =
              typeof chunk.input === 'string' ? chunk.input : JSON.stringify(chunk.input ?? {});
            toolCalls.push({ id: chunk.id, name: chunk.name, args });
            if (stream) {
              sse(
                res,
                CHUNK({
                  tool_calls: [
                    {
                      index: toolCalls.length - 1,
                      id: chunk.id,
                      type: 'function',
                      function: { name: chunk.name, arguments: args },
                    },
                  ],
                }),
              );
            }
          } else {
            finish = chunk.reason === 'tool_calls' ? 'tool_calls' : chunk.reason;
          }
        }
        if (toolCalls.length && finish === 'stop') finish = 'tool_calls';

        if (stream) {
          sse(res, CHUNK({}, finish));
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'lmproxy',
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  finish_reason: finish,
                  message: {
                    role: 'assistant',
                    content: text,
                    tool_calls: toolCalls.length
                      ? toolCalls.map((t, i) => ({
                          index: i,
                          id: t.id,
                          type: 'function',
                          function: { name: t.name, arguments: t.args },
                        }))
                      : undefined,
                  },
                },
              ],
            }),
          );
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (cause) {
      log.error('proxy error: %s', (cause as Error).message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (cause as Error).message }));
    }
  };
}
