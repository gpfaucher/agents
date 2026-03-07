import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);

const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || "agent-sandboxes";

function podName(issueId: string): string {
  const safe = issueId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
  return `sandbox-${safe}`;
}

async function execInBrowser(issueIdentifier: string, script: string): Promise<string> {
  const name = podName(issueIdentifier);
  const { stdout } = await exec(
    "kubectl",
    [
      "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "browser",
      "--", "npx", "playwright", "test", "--config=/dev/null", "-x",
    ],
    { timeout: 120_000 },
  );
  // Fallback: just run node directly with the script
  // The playwright image has node + playwright pre-installed
  const { stdout: result } = await exec(
    "kubectl",
    [
      "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "browser",
      "--", "node", "-e", script,
    ],
    { timeout: 120_000 },
  );
  return result.trim();
}

// Simpler exec that just runs node in the browser container
async function nodeInBrowser(issueIdentifier: string, script: string): Promise<string> {
  const name = podName(issueIdentifier);
  const { stdout } = await exec(
    "kubectl",
    [
      "exec", name, "-n", SANDBOX_NAMESPACE, "-c", "browser",
      "--", "node", "-e", script,
    ],
    { timeout: 120_000 },
  );
  return stdout.trim();
}

export const browserNavigate = tool(
  "browser_navigate",
  "Navigate the Playwright browser in the sandbox to a URL and return the page title and content summary.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to navigate to (use localhost:8000 for the app container)"),
  },
  async ({ issueIdentifier, url }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
        console.log('Title:', await page.title());
        console.log('URL:', page.url());
        const text = await page.innerText('body').catch(() => '');
        console.log('Body preview:', text.slice(0, 500));
        await browser.close();
      })();
    `;
    const result = await nodeInBrowser(issueIdentifier, script);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

export const browserScreenshot = tool(
  "browser_screenshot",
  "Take a screenshot of a page in the sandbox browser. Returns base64-encoded PNG.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to screenshot (use localhost:8000 for the app container)"),
    fullPage: z.boolean().optional().describe("Capture full scrollable page (default true)"),
  },
  async ({ issueIdentifier, url, fullPage }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
        const buf = await page.screenshot({ fullPage: ${fullPage !== false} });
        process.stdout.write(buf.toString('base64'));
        await browser.close();
      })();
    `;
    const base64 = await nodeInBrowser(issueIdentifier, script);
    const sizeKb = Math.round(base64.length * 3 / 4 / 1024);
    return {
      content: [
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png" as const, data: base64 },
        },
        { type: "text" as const, text: `Screenshot of ${url} (${sizeKb}KB)` },
      ],
    };
  },
);

export const browserClick = tool(
  "browser_click",
  "Click an element on a page in the sandbox browser and return the result.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to navigate to"),
    selector: z.string().describe("CSS selector of the element to click"),
  },
  async ({ issueIdentifier, url, selector }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
        await page.click(${JSON.stringify(selector)});
        await page.waitForTimeout(1000);
        console.log('Clicked:', ${JSON.stringify(selector)});
        console.log('Current URL:', page.url());
        console.log('Title:', await page.title());
        await browser.close();
      })();
    `;
    const result = await nodeInBrowser(issueIdentifier, script);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

export const browserFill = tool(
  "browser_fill",
  "Fill a form field on a page in the sandbox browser.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to navigate to"),
    selector: z.string().describe("CSS selector of the form field"),
    value: z.string().describe("Value to fill in"),
  },
  async ({ issueIdentifier, url, selector, value }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
        await page.fill(${JSON.stringify(selector)}, ${JSON.stringify(value)});
        console.log('Filled:', ${JSON.stringify(selector)}, 'with:', ${JSON.stringify(value)});
        await browser.close();
      })();
    `;
    const result = await nodeInBrowser(issueIdentifier, script);
    return { content: [{ type: "text" as const, text: result }] };
  },
);
