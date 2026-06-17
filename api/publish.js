const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'dashboarddata';
const PARTITION_KEY = 'dashboard';
const ROW_KEY = 'data';

function merge3(base, mine, server) {
  const result = { ...server };
  for (const key of Object.keys({ ...base, ...mine })) {
    if (JSON.stringify(mine[key]) !== JSON.stringify(base[key])) {
      result[key] = mine[key];
    }
  }
  return result;
}

app.http('data', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const connectionString = process.env.AzureWebJobsStorage;
      if (!connectionString) {
        return { status: 500, jsonBody: { error: 'AzureWebJobsStorage not configured' } };
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
    const SECRET = process.env.PUBLISH_SECRET;
    if (SECRET && request.headers.get('x-publish-secret') !== SECRET) {
      return { status: 401, jsonBody: { error: 'Unauthorized' } };
    }

    let body;
    try { body = await request.json(); }
    catch { return { status: 400, jsonBody: { error: 'Invalid JSON body' } }; }

    const { ws, sum, baseline } = body;
    if (!ws || !sum) return { status: 400, jsonBody: { error: 'Missing ws or sum in body' } };

    try {
      const connectionString = process.env.AzureWebJobsStorage;
      if (!connectionString) {
        return { status: 500, jsonBody: { error: 'AzureWebJobsStorage not configured' } };
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

      const payload = { ws: mergedWs, sum: mergedSum, updatedAt: new Date().toISOString() };

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
