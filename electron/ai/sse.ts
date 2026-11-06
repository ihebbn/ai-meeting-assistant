/**
 * Minimal Server-Sent Events reader for streaming HTTP bodies. Handles chunk boundaries
 * inside lines, CRLF / LF / CR terminators, multi-line data, comments, and a final event
 * that is not followed by a blank line.
 */
export type SseMessage = { event: string | null; data: string };

export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];

  const dispatch = (): SseMessage | null => {
    const message = data.length > 0 ? { event, data: data.join('\n') } : null;
    event = null;
    data = [];
    return message;
  };

  const handleLine = (line: string): SseMessage | null => {
    if (line === '') {
      return dispatch();
    }
    if (line.startsWith(':')) {
      return null; // comment / keep-alive
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      data.push(value);
    } else if (field === 'event') {
      event = value;
    }
    return null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match) {
        break;
      }
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more input.
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        break;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const message = handleLine(line);
      if (message) {
        yield message;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const message = handleLine(buffer.replace(/\r$/, ''));
    if (message) {
      yield message;
    }
  }
  const last = dispatch();
  if (last) {
    yield last;
  }
}
