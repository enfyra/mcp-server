import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

const AUTH_TIMEOUT_MS = 120_000;

type BrowserAuthResult = { token: string };

function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function isLocalhostCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
  });
}

export async function browserAuth(appUrl: string): Promise<BrowserAuthResult> {
  return new Promise<BrowserAuthResult>((resolve, reject) => {
    let server: Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (server) server.close();
    };

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      const body = await readBody(req);
      let token = '';
      try {
        const parsed = JSON.parse(body);
        token = parsed.pat || '';
      } catch {
        const url = new URL(req.url || '/', `http://localhost`);
        token = url.searchParams.get('pat') || '';
      }

      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end('{"ok":true}');

      if (settled) return;
      settled = true;

      if (!token) {
        cleanup();
        reject(new Error('Received empty token from browser'));
        return;
      }

      cleanup();
      resolve({ token });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (!address || typeof address === 'string') {
        cleanup();
        reject(new Error('Failed to start local auth server'));
        return;
      }

      const port = address.port;
      const callback = `http://localhost:${port}`;
      const setupUrl = `${appUrl.replace(/\/+$/, '')}/mcp-setup?callback=${encodeURIComponent(callback)}`;

      if (!isLocalhostCallback(callback)) {
        cleanup();
        reject(new Error('Internal error: callback is not localhost'));
        return;
      }

      console.error(`→ Opening browser for authentication...`);
      console.error(`  If the browser does not open, visit:\n  ${setupUrl}`);
      openBrowser(setupUrl);

      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timed out (120s). Try pasting a token manually instead.'));
      }, AUTH_TIMEOUT_MS);
    });

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
