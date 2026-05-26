const REPO = 'ROHITH7901112/Evora-HARTS-Transformation-Progress-Dashboard-';
const API  = `https://api.github.com/repos/${REPO}/contents/index.html`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PAT = process.env.GH_PAT;
  if (!PAT) return res.status(500).json({ error: 'GH_PAT env var not configured' });

  const { ws, sum } = req.body;
  if (!ws || !sum) return res.status(400).json({ error: 'Missing ws or sum in body' });

  // Fetch current file to get SHA and content
  const getRes = await fetch(API, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!getRes.ok) return res.status(502).json({ error: 'GitHub fetch failed: ' + getRes.status });
  const file = await getRes.json();

  let html = Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8');

  // Replace WS[] and SUM[] data blocks
  html = html.replace(/const WS=\[[\s\S]*?\n\];/, 'const WS=' + JSON.stringify(ws, null, 2) + ';');
  html = html.replace(/const SUM=\[[\s\S]*?\n\];/, 'const SUM=' + JSON.stringify(sum, null, 2) + ';');

  // Update live-badge date
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  html = html.replace(/Live from Jira · [^<"]+/, 'Live from Jira · ' + today);

  // Commit back to GitHub
  const putRes = await fetch(API, {
    method: 'PUT',
    headers: {
      Authorization: `token ${PAT}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'Dashboard edit: ' + new Date().toUTCString(),
      content: Buffer.from(html, 'utf8').toString('base64'),
      sha: file.sha
    })
  });

  if (putRes.ok) return res.json({ ok: true });
  const err = await putRes.json();
  return res.status(500).json({ error: err.message || 'GitHub commit failed' });
}
