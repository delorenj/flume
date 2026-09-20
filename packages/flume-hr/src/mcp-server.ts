#!/usr/bin/env node
/**
 * Flume's MCP server: the read-only org surface.
 *
 * Deliberately read-only. Hiring is a mutation with consent gates, credential
 * scrubbing and a postcondition audit; an agent that wants to hire runs
 * `flume hire` and gets all of that, rather than reaching a thinner path through
 * a tool call.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerOrgMcpTools } from "./org/mcp";

function asText(payload: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
    }],
  };
}

const server = new McpServer({ name: "flume", version: "1.0.0" });

registerOrgMcpTools(server, asText);

const transport = new StdioServerTransport();
await server.connect(transport);
