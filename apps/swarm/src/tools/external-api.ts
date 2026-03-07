import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const externalApiRequest = tool(
  "external_api_request",
  "Make an HTTP request to an external API (e.g. Ultimo) for verification. Supports GET, POST, PUT, DELETE.",
  {
    url: z.string().describe("Full URL to request (e.g. https://demo.ultimo.com/api/v1/object/Job)"),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method"),
    headers: z.record(z.string()).optional().describe("Additional request headers"),
    body: z.string().optional().describe("Request body (JSON string)"),
    apiKeyEnvVar: z.string().optional().describe("Environment variable name containing the API key (default: ULTIMO_API_KEY)"),
    apiKeyHeader: z.string().optional().describe("Header name for the API key (default: X-Api-Key)"),
  },
  async ({ url, method, headers, body, apiKeyEnvVar, apiKeyHeader }) => {
    const envVar = apiKeyEnvVar || "ULTIMO_API_KEY";
    const headerName = apiKeyHeader || "X-Api-Key";
    const apiKey = process.env[envVar];

    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };

    if (apiKey) {
      requestHeaders[headerName] = apiKey;
    }

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body || undefined,
      });

      const status = response.status;
      const responseHeaders = Object.fromEntries(response.headers.entries());
      let responseBody: string;
      try {
        const json = await response.json();
        responseBody = JSON.stringify(json, null, 2);
      } catch {
        responseBody = await response.text();
      }

      // Truncate large responses
      if (responseBody.length > 10000) {
        responseBody = responseBody.slice(0, 10000) + "\n... (truncated)";
      }

      return {
        content: [{
          type: "text" as const,
          text: `HTTP ${status}\nHeaders: ${JSON.stringify(responseHeaders, null, 2)}\n\nBody:\n${responseBody}`,
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Request failed: ${msg}` }] };
    }
  },
);
