import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const googleApiKey =
  process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!googleApiKey) {
  throw new Error(
    "Missing Google LLM API key. Set GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
  );
}

process.env.GOOGLE_API_KEY = googleApiKey;

const targetUrl = process.env.TARGET_URL ?? "https://example.com";

const stagehand = new Stagehand({
  env: "BROWSERBASE",
  model: "google/gemini-2.5-flash",
});

await stagehand.init();
const sessionUrl = stagehand.sessionUrl;
const debugUrl = stagehand.debugUrl;
const sessionId = stagehand.sessionId;

try {
  const page =
    stagehand.context.activePage() ??
    stagehand.context.pages()[0] ??
    (await stagehand.context.newPage());

  await stagehand.context.setActivePage(page);

  await page.goto(targetUrl, { waitUntil: "load" });

  const schema = z.object({
    title: z.string(),
    heading: z.string(),
  });

  const extraction = await stagehand.extract({
    schema,
    instruction: "Extract the page title and the main heading.",
  });

  const runsDir = path.join(process.cwd(), "runs");
  const outputFile = path.join(runsDir, "output.jsonl");

  await mkdir(runsDir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    targetUrl,
    sessionUrl,
    debugUrl,
    sessionId,
    extraction,
  });
  await appendFile(outputFile, `${line}\n`, "utf8");

  console.log(`Wrote extraction output to ${outputFile}`);
} finally {
  await stagehand.close();
}
