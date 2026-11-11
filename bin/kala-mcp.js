#!/usr/bin/env node
import { KalaMcpServer } from '../src/mcp/mcp-server.js';

const server = new KalaMcpServer({
  projectCwd: process.env.KALA_PROJECT_CWD || process.cwd(),
});
server.startStdio();
