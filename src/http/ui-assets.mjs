import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/ui/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/demo.mjs', ['demo.mjs', 'text/javascript; charset=utf-8']],
  ['/ui/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/ui/dags.css', ['dags.css', 'text/css; charset=utf-8']],
]);

export async function serveUi(path, response) {
  const item = files.get(path);
  if (!item) return false;
  const body = await readFile(new URL(`../ui/${item[0]}`, import.meta.url));
  response.writeHead(200, {
    'content-type': item[1], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(body);
  return true;
}
