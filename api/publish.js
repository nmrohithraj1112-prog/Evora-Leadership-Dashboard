const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'dashboarddata';
const PARTITION_KEY = 'dashboard';
const ROW_KEY = 'data';

const MAX_BODY_BYTES = 512 * 1024; // 512 KB cap on incoming edit payload

function merge3(base, mine, server) {
  const result = { ...server };
  for (const key of Object.keys({ ...base, ...mine })) {
    if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) {
      result[key] = mine[key];
    }
  }
  return result;
}

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

app.http('data', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const connectionString = process.env.STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        return { status: 500, jsonBody: { error: 'STORAGE_CONNECTION_STRING not configured' } };
      }

      const tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);

      try {
        const entity = await tableClient.getEntity(PARTITION_KEY, ROW_KEY);
        const data = JSON.parse(entity.data);
        return { jsonBody: data };
      } catch (err) {
        return { jsonBody: { ws: [], sum: [], updatedAt: new Date().toISOString() } };
      }
    } catch (err) {
      context.log('Error fetching data:', err);
      return { status: 500, jsonBody: { error: err.message || 'Failed to fetch data' } };
    }
  }
});

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

    const { ws, sum, baseline } = body;
    if (!Array.isArray(ws) || !Array.isArray(sum)) {
      return { status: 400, jsonBody: { error: 'ws and sum must be arrays' } };
    }

    try {
      const connectionString = process.env.STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        return { status: 500, jsonBody: { error: 'STORAGE_CONNECTION_STRING not configured' } };
      }

      const tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);

      let server;
      try {
        const entity = await tableClient.getEntity(PARTITION_KEY, ROW_KEY);
        server = JSON.parse(entity.data);
      } catch (err) {
        server = { ws: [], sum: [] };
      }

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

      const payload = {
        ws: mergedWs,
        sum: mergedSum,
        updatedAt: new Date().toISOString(),
        lastEditedBy: editor,
        lastEditedAt: new Date().toISOString()
      };
      context.log(`Dashboard edited by ${editor} at ${payload.lastEditedAt}`);

      const entity = {
        partitionKey: PARTITION_KEY,
        rowKey: ROW_KEY,
        data: JSON.stringify(payload)
      };

      await tableClient.upsertEntity(entity, 'Merge');

      return { jsonBody: { ok: true, merged: payload } };
    } catch (err) {
      context.log('Error:', err);
      return { status: 500, jsonBody: { error: err.message || 'Failed to update data' } };
    }
  }
});
