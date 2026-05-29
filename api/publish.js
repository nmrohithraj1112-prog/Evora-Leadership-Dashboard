const { app } = require('@azure/functions');

const REPO = 'ROHITH7901112/Evora-HARTS-Transformation-Progress-Dashboard-';
const API  = `https://api.github.com/repos/${REPO}/contents/data.json`;

function merge3(base, mine, server) {
  const result = { ...server };
  for (const key of Object.keys({ ...base, ...mine })) {
    if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) {
      result[key] = mine[key];
    }
  }
  return result;
}

app.http('publish', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const PAT = process.env.GH_PAT;
    if (!PAT) return { status: 500, jsonBody: { error: 'GH_PAT env var not configured' } };

    const SECRET = process.env.PUBLISH_SECRET;
    if (SECRET && request.headers.get('x-publish-secret') !== SECRET) {
      return { status: 401, jsonBody: { error: 'Unauthorized' } };
    }

    let body;
    try { body = await request.json(); }
    catch { return { status: 400, jsonBody: { error: 'Invalid JSON body' } }; }

    const { ws, sum, baseline } = body;
    if (!ws || !sum) return { status: 400, jsonBody: { error: 'Missing ws or sum in body' } };

    const getRes = await fetch(API, {
      headers: { Authorization: `token ${PAT}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!getRes.ok) return { status: 502, jsonBody: { error: 'GitHub fetch failed: ' + getRes.status } };

    const file = await getRes.json();
    const server = JSON.parse(Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8'));

    let mergedWs, mergedSum;
    if (baseline) {
      mergedWs = ws.map((mine, i) => {
        const base = (baseline.ws || [])[i] || mine;
        const srv  = (server.ws  || [])[i] || mine;
        return merge3(base, mine, srv);
      });
      mergedSum = sum.map((mine, i) => {
        const base = (baseline.sum || [])[i] || mine;
        const srv  = (server.sum  || [])[i] || mine;
        return merge3(base, mine, srv);
      });
    } else {
      mergedWs  = ws;
      mergedSum = sum;
    }

    const payload = { ws: mergedWs, sum: mergedSum, updatedAt: new Date().toISOString() };

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

    if (putRes.ok) return { jsonBody: { ok: true, merged: payload } };

    if (putRes.status === 409 || putRes.status === 422) {
      return { status: 409, jsonBody: { error: 'Conflict — someone published at the same time. Please try again.' } };
    }

    const err = await putRes.json();
    return { status: 500, jsonBody: { error: err.message || 'GitHub commit failed' } };
  }
});
