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
      "--", "node", "-e", script,
    ],
    { timeout: 60_000 },
  );
  return stdout.trim();
}

export const browserNavigate = tool(
  "browser_navigate",
  "Navigate the Playwright browser in the sandbox to a URL.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to navigate to"),
  },
  async ({ issueIdentifier, url }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto('${url.replace(/'/g, "\\'")}');
        console.log('Title:', await page.title());
        console.log('URL:', page.url());
        await browser.close();
      })();
    `;
    const result = await execInBrowser(issueIdentifier, script);
    return { content: [{ type: "text" as const, text: result }] };
  },
);

export const browserScreenshot = tool(
  "browser_screenshot",
  "Take a screenshot of the current page in the sandbox browser.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to screenshot"),
  },
  async ({ issueIdentifier, url }) => {
    const name = podName(issueIdentifier);
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto('${url.replace(/'/g, "\\'")}');
        await page.screenshot({ path: '/tmp/screenshot.png', fullPage: true });
        const fs = require('fs');
        const data = fs.readFileSync('/tmp/screenshot.png');
        console.log(data.toString('base64'));
        await browser.close();
      })();
    `;
    const base64 = await execInBrowser(issueIdentifier, script);
    return {
      content: [
        { type: "text" as const, text: `Screenshot taken (${Math.round(base64.length * 3 / 4 / 1024)}KB). Base64 data available.` },
      ],
    };
  },
);

export const browserClick = tool(
  "browser_click",
  "Click an element on a page in the sandbox browser.",
  {
    issueIdentifier: z.string().describe("Linear issue identifier of the sandbox"),
    url: z.string().describe("URL to navigate to"),
    selector: z.string().describe("CSS selector of the element to click"),
  },
  async ({ issueIdentifier, url, selector }) => {
    const script = `
      const { chromium } = require('playwright');
      (async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto('${url.replace(/'/g, "\\'")}');
        await page.click('${selector.replace(/'/g, "\\'")}');
        await page.waitForTimeout(1000);
        console.log('Clicked:', '${selector}');
        console.log('Current URL:', page.url());
        await browser.close();
      })();
    `;
    const result = await execInBrowser(issueIdentifier, script);
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
        const browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto('${url.replace(/'/g, "\\'")}');
        await page.fill('${selector.replace(/'/g, "\\'")}', '${value.replace(/'/g, "\\'")}');
        console.log('Filled:', '${selector}', 'with:', '${value}');
        await browser.close();
      })();
    `;
    const result = await execInBrowser(issueIdentifier, script);
    return { content: [{ type: "text" as const, text: result }] };
  },
);
