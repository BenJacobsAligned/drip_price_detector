import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";

const googleApiKey =
  process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!googleApiKey) {
  throw new Error(
    "Missing Google LLM API key. Set GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
  );
}

process.env.GOOGLE_API_KEY = googleApiKey;

const stagehand = new Stagehand({
  env: "BROWSERBASE",
  model: "google/gemini-2.5-flash",
});

await stagehand.init();

try {
  await stagehand.page.goto("https://example.com", { waitUntil: "load" });

  const schema = z.object({
    title: z.string(),
    heading: z.string(),
  });

  const data = await stagehand.page.extract({
    schema,
    instruction: "Extract the page title and the main heading.",
  });

  console.log(JSON.stringify(data, null, 2));
} finally {
  await stagehand.close();
}
