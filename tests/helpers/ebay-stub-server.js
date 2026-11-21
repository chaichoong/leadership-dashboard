// A stand-in for eBay, for tests/ebay-search.test.js.
//
// It runs as its OWN process on purpose. The script under test is driven with execFileSync, which
// blocks Node's event loop, so a server created inside the test file could never answer the request
// it is there to answer: every call timed out instead of being served (seen while writing this test,
// 21 Nov 2026). A separate process answers while the test waits.
//
// argv: <plan.json> <calls.jsonl>. The plan is re-read on EVERY request, so a test changes the
// answer by rewriting that file. Each request is appended to the calls file.
// It prints "PORT=<n>" on stdout once it is listening, and answers nothing else.
const { createServer } = require('http');
const { readFileSync, appendFileSync } = require('fs');

const [planPath, callsPath] = process.argv.slice(2);

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    appendFileSync(callsPath, JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }) + '\n');
    let step;
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      step = req.url.startsWith('/identity') ? plan.token : plan.search;
    } catch (e) {
      step = { status: 500, body: { planError: String(e && e.message) } };
    }
    res.writeHead(step.status, { 'Content-Type': 'application/json' });
    res.end(typeof step.body === 'string' ? step.body : JSON.stringify(step.body));
  });
}).listen(0, '127.0.0.1', function () {
  process.stdout.write('PORT=' + this.address().port + '\n');
});
