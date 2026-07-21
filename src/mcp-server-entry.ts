import { runEnfyraMcpServer } from './lib/enfyra-mcp-server.js';

runEnfyraMcpServer().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
