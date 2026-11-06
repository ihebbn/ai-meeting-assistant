import * as http from 'node:http';

export type Recorded = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** Local HTTP server for provider tests. Records requests; the handler writes the reply. */
export async function startMockServer(
  handler: (req: Recorded, res: http.ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
