import 'dotenv/config';
import { Client, Connection } from '@temporalio/client';
import path from 'node:path';
import { createApp } from './server/app';

// Claude Code SDK uses OAuth; ANTHROPIC_API_KEY causes claude CLI to fail
delete process.env.ANTHROPIC_API_KEY;

let temporalClient: Client | null = null;

async function getClient(): Promise<Client> {
  if (!temporalClient) {
    const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
    const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
    const connection = await Connection.connect({ address });
    temporalClient = new Client({ connection, namespace });
  }
  return temporalClient;
}

const webDist = path.resolve(__dirname, '../web/dist');
const { app } = createApp(getClient, webDist);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
