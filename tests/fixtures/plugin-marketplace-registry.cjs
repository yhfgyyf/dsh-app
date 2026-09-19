// A private npm registry containing only the inert bundle generated for one test.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

exports.startRegistry = async function startRegistry(data) {
  const name = 'dsh-marketplace-fixture-' + randomBytes(6).toString('hex');
  const version = '1.0.0';
  const githubUrl = 'https://github.com/fixture-owner/marketplace-acceptance';
  const downloads = { downloads: 1234, start: '2026-08-19', end: '2026-09-18', package: name };
  const manifest = {
    name, version, type: 'module', description: 'Generated local marketplace acceptance fixture',
    keywords: ['dsh', 'dsh-plugin', 'deepseek-harness'],
    repository: { type: 'git', url: 'git+' + githubUrl + '.git' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    files: ['probe.mjs', 'cordis.patch.yml'],
  };
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  const bundle = join(data, 'registry', 'package');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(bundle, 'probe.mjs'), 'export function apply(ctx) { ctx.provide("marketplaceAcceptanceFixture", "active"); }\n');
  writeFileSync(join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: marketplace-acceptance-fixture\n      name: ./probe.mjs\n');
  const tarball = execFileSync('tar', ['-czf', '-', '-C', join(data, 'registry'), 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 1024 * 1024,
  });
  const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
  const sha256 = createHash('sha256').update(tarball).digest('hex');
  const requests = [];
  const modelRequests = [];
  let modelReport;
  let origin;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === '/v1/chat/completions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      modelRequests.push(input);
      if (!modelReport) { response.writeHead(500); response.end('Missing test model response'); return; }
      const content = JSON.stringify(modelReport);
      const result = { id: 'marketplace-review-fixture', created: 1, model: input.model };
      const usage = { prompt_tokens: 128, completion_tokens: 128, total_tokens: 256 };
      if (input.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
          response.write(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage } : {}) })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...result, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage }));
      }
      return;
    }
    requests.push({ method: request.method, path: url.pathname, query: url.searchParams.get('text') });
    const release = { ...manifest, dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity,
      shasum: createHash('sha1').update(tarball).digest('hex'),
    } };
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/downloads/point/last-month/' + name) {
      response.end(JSON.stringify(downloads));
    } else if (url.pathname === '/-/v1/search') {
      response.end(JSON.stringify({ objects: [{ package: {
        name, version, description: manifest.description, keywords: manifest.keywords,
        date: '2026-09-18T00:00:00.000Z', links: { npm: `https://www.npmjs.com/package/${name}` },
      }, score: { final: 1, detail: { quality: 1, popularity: 0, maintenance: 1 } } }], total: 1, time: '2026-09-18T00:00:00.000Z' }));
    } else if (decodeURIComponent(url.pathname) === `/${name}`) {
      response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: { [version]: release }, time: { [version]: '2026-09-18T00:00:00.000Z' } }));
    } else if (decodeURIComponent(url.pathname) === `/${name}/${version}`) {
      response.end(JSON.stringify(release));
    } else if (url.pathname === `/${name}/-/${name}-${version}.tgz`) {
      response.setHeader('Content-Type', 'application/octet-stream'); response.end(tarball);
    } else {
      response.statusCode = 404; response.end(JSON.stringify({ error: 'Only the generated fixture is available' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const preload = join(data, 'registry-fetch.cjs');
  // Loaded only in this test's owned child host. Production keeps its fixed endpoint.
  const packageCommands = join(data, 'package-commands.jsonl');
  writeFileSync(packageCommands, '');
  writeFileSync(preload, `const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['https://registry.npmjs.org', 'https://api.npmjs.org'].includes(url.origin)) {
    const mapped = ${JSON.stringify(origin)} + url.pathname + url.search;
    return original(input instanceof Request ? new Request(mapped, input) : mapped, options);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Test blocked external fetch: ' + url.origin);
  return original(input, options);
};
const cp = require('node:child_process');
const spawn = cp.spawn;
cp.spawn = function(command, args, options) {
  if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && require('node:path').basename(arg) === 'pnpm.mjs')) {
    require('node:fs').appendFileSync(${JSON.stringify(packageCommands)}, JSON.stringify({command, args}) + '\\n');
  }
  return spawn.apply(this, arguments);
};
require('node:module').syncBuiltinESMExports();
`);
  return {
    name, version, spec: `${name}@${version}`, manifest, origin, requests, preload, sha256,
    githubUrl, downloads, modelRequests, packageCommands,
    setModelReport: value => { modelReport = value; }, close: () => server.close(),
  };
};
