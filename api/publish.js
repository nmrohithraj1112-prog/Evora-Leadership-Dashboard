const REPO = 'ROHITH7901112/Evora-HARTS-Transformation-Progress-Dashboard-';
const API  = `https://api.github.com/repos/${REPO}/contents/data.json`;

// 3-way merge for a single object:
// - base   : what the client had when they loaded the page
// - mine   : what the client has now (after their edits)
// - server : what is currently in the repo (may have changed since they loaded)
// Result   : server state + only the fields the client actually changed
function merge3(base, mine, server) {
  const result = { ...server };
  for (const key of Object.keys({ ...base, ...mine })) {
    if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) {
      result[key] = mine[key]; // client changed this field — apply it
    }
    // otherwise keep server's value (another person may have updated it)
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PAT = process.env.GH_PAT;
  if (!PAT) return res.status(500).json({ error: 'GH_PAT env var not configured' });

  const SECRET = process.env.PUBLISH_SECRET;
  if (SECRET && req.headers['x-publish-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { ws, sum, baseline } = req.body;
  if (!ws || !sum) return res.status(400).json({ error: 'Missing ws or sum in body' });

  // Fetch current data.json from GitHub
  const getRes = await fetch(API, {
    headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!getRes.ok) return res.status(502).json({ error: 'GitHub fetch failed: ' + getRes.status });
  const file = await getRes.json();
  const server = JSON.parse(Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8'));

  let mergedWs, mergedSum;

  if (baseline) {
    // 3-way merge: only apply fields the client actually changed
    mergedWs = ws.map((mine, i) => {
      const base = (baseline.ws || [])[i] || mine;
      const srv  = (server.ws || [])[i]  || mine;
      return merge3(base, mine, srv);
    });
    mergedSum = sum.map((mine, i) => {
      const base = (baseline.sum || [])[i] || mine;
      const srv  = (server.sum || [])[i]  || mine;
      return merge3(base, mine, srv);
    });
  } else {
    // No baseline sent — fall back to last-write-wins
    mergedWs  = ws;
    mergedSum = sum;
  }

  const payload = {
    ws: mergedWs,
    sum: mergedSum,
    updatedAt: new Date().toISOString()
  };

  const putRes = await fetch(API, {
    method: 'PUT',
    headers: {
      Authorization: `token ${PAT}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: 'Dashboard edit: ' + new Date().toUTCString(),
      content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
      sha: file.sha
    })
  });

  if (putRes.ok) return res.json({ ok: true, merged: payload });

  // If SHA conflict (concurrent publish), retry once
  if (putRes.status === 409 || putRes.status === 422) {
    return res.status(409).json({ error: 'Conflict — someone published at the same time. Please try again.' });
  }

  const err = await putRes.json();
  return res.status(500).json({ error: err.message || 'GitHub commit failed' });
}
