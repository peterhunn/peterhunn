#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createX490McpServer } from "./server.js";

const server = createX490McpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
