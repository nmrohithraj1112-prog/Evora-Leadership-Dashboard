const { app } = require('@azure/functions');

// GitHub is the single datastore: the dashboard reads /data.json (static, deployed
// from the repo) and every save commits data.json back to the repo, which triggers
// a Static Web Apps redeploy. No Azure Table Storage involved.
const GITHUB_OWNER = 'nmrohithraj1112-prog';
const GITHUB_REPO = 'Evora-Leadership-Dashboard';
const GITHUB_BRANCH = 'main';
const FILE_PATH = 'data.json';

const MAX_BODY_BYTES = 512 * 1024; // 512 KB cap on incoming edit payload

// Decode the identity Azure Static Web Apps injects after SSO login.
// This header is set server-side by the SWA platform and cannot be forged by the browser.
function getPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

app.http('publish', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    // Two accepted callers, nothing else:
    //  (1) a human with a valid SSO session carrying the evorastaff role, or
    //  (2) the automation routine presenting the strong machine key.
    const principal = getPrincipal(request);
    const isEvoraStaff = !!(principal && principal.userId &&
      Array.isArray(principal.userRoles) && principal.userRoles.includes('evorastaff'));

    const API_KEY = process.env.PUBLISH_API_KEY;
    const presentedKey = request.headers.get('x-api-key');
    const isAutomation = !!(API_KEY && presentedKey === API_KEY);

    if (!isEvoraStaff && !isAutomation) {
      return { status: 401, jsonBody: { error: 'Unauthorized' } };
    }
    const editor = isEvoraStaff
      ? (principal.userDetails || principal.userId)
      : 'automation (daily refresh)';

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return { status: 500, jsonBody: { error: 'GITHUB_TOKEN not configured' } };
    }

    // Read raw text first so we can enforce a size cap before parsing.
    let raw;
    try { raw = await request.text(); }
    catch { return { status: 400, jsonBody: { error: 'Could not read body' } }; }
    if (raw.length > MAX_BODY_BYTES) {
      return { status: 413, jsonBody: { error: 'Payload too large' } };
    }

    let body;
    try { body = JSON.parse(raw); }
    catch { return { status: 400, jsonBody: { error: 'Invalid JSON body' } }; }

    const { ws, sum } = body;
    if (!Array.isArray(ws) || !Array.isArray(sum)) {
      return { status: 400, jsonBody: { error: 'ws and sum must be arrays' } };
    }

    const payload = {
      ws,
      sum,
      updatedAt: new Date().toISOString(),
      lastEditedBy: editor,
      lastEditedAt: new Date().toISOString()
    };
    const contentB64 = Buffer.from(JSON.stringify(payload, null, 2)).toString('base64');

    const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const ghHeaders = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'evora-dashboard',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    try {
      // Look up the current blob sha so we can update (not just create) the file.
      let sha;
      const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
      if (getRes.ok) {
        const j = await getRes.json();
        sha = j.sha;
      }

      const putRes = await fetch(apiBase, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Dashboard update by ${editor} (${payload.updatedAt})`,
          content: contentB64,
          branch: GITHUB_BRANCH,
          ...(sha ? { sha } : {})
        })
      });

      if (putRes.status === 409) {
        // Stale sha — someone else committed first. Let the client retry.
        return { status: 409, jsonBody: { error: 'Conflict — concurrent update, please retry' } };
      }
      if (!putRes.ok) {
        const t = await putRes.text();
        return { status: 502, jsonBody: { error: 'GitHub commit failed', detail: t.slice(0, 300) } };
      }

      context.log(`data.json committed by ${editor} at ${payload.updatedAt}`);
      return { jsonBody: { ok: true, updatedAt: payload.updatedAt } };
    } catch (err) {
      context.log('Error:', err);
      return { status: 500, jsonBody: { error: err.message || 'Failed to commit data' } };
    }
  }
});
