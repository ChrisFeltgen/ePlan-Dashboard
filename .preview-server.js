// Minimal static file server, zero dependencies, used only to preview
// workload-dashboard.html + workload-snapshot.json the way IIS will serve
// them (fetch() of a local JSON file needs http://, not file://).
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = process.env.PORT || 5757;

const mime = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  let filePath = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (req.url === '/') filePath = path.join(root, 'workload-dashboard.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log(`Preview server on http://localhost:${port}`));
