#!/usr/bin/env node
import { BlackboxMcpServer } from '../src/mcp/mcp-server.js';

const server = new BlackboxMcpServer({
  projectCwd: process.env.BLACKBOX_PROJECT_CWD || process.env.KALA_PROJECT_CWD || process.cwd(),
});
server.startStdio();
