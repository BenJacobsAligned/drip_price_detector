import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const runsDir = path.join(process.cwd(), "runs");
const outputFile = path.join(runsDir, "output.jsonl");

const resultsSchema = z.object({
  products: z.array(
    z.object({
      product_name: z.string(),
      product_url: z.string(),
      initial_price_text: z.string().optional().nullable(),
      qualifiers: z.string().optional().nullable(),
    }),
  ),
});

const cartSchema = z.object({
  final_total_text: z.string().optional().nullable(),
  fee_lines: z
    .array(
      z.object({
        label: z.string(),
        amount_text: z.string(),
      }),
    )
    .optional(),
  line_items: z
    .array(
      z.object({
        label: z.string(),
        amount_text: z.string(),
      }),
    )
    .optional(),
});

type CartExtraction = z.infer<typeof cartSchema>;

type OutputRecord = {
  timestamp: string;
  site: "discounttire";
  search_query: string;
  product_name: string | null;
  product_url: string | null;
  initial_price_text: string | null;
  qualifiers: string | null;
  final_total_text: string | null;
  fee_lines: { label: string; amount_text: string }[];
  line_items: { label: string; amount_text: string }[];
  sessionUrl?: string;
  debugUrl?: string;
  sessionId?: string;
  status: "ok" | "failed" | "blocked";
  notes: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const asArray = <T,>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

const appendOutput = async (record: OutputRecord) => {
  await mkdir(runsDir, { recursive: true });
  await appendFile(outputFile, `${JSON.stringify(record)}\n`, "utf8");
};

const formatErrorNotes = (notes: string[], error: unknown) => {
  const normalized =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : String(error));
  notes.push(`error.name=${normalized.name}`);
  notes.push(`error.message=${normalized.message}`);
  notes.push(`error.stack=${normalized.stack ?? "missing stack"}`);
  return normalized;
};

const normalizeUrl = (href: string) => {
  try {
    return new URL(href, "https://www.discounttire.com").toString();
  } catch {
    return href;
  }
};

const retryStep = async <T>(label: string, action: () => Promise<T>) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(1000);
      }
    }
  }
  if (lastError instanceof BlockedError) {
    throw lastError;
  }
  throw new Error(
    `${label} failed after retries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const observeAndAct = async (
  stagehand: Stagehand,
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  instruction: string,
  notes: string[],
) => {
  const observed = (await stagehand.observe({ instruction })) ?? [];
  const actions = asArray<unknown>(observed);

  if (actions.length === 0) {
    notes.push(`observe returned no actions for: ${instruction}`);
    await stagehand.act(`Perform the action described: ${instruction}`);
    return false;
  }

  const action = actions[0] as { selector?: string };
  try {
    const result = await stagehand.act(action);
    if (result && typeof result === "object" && "success" in result) {
      if ((result as { success?: boolean }).success === false) {
        throw new Error("stagehand.act returned success=false");
      }
    }
  } catch (error) {
    notes.push(
      `stagehand.act failed, trying playwright click: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (action?.selector) {
      await page.click(action.selector, { timeout: 10000 });
      notes.push(`playwright click success: ${action.selector}`);
    } else {
      throw error;
    }
  }
  return true;
};

const waitForUrlChangeOrDom = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  beforeUrl: string,
  domSelector?: string,
  timeoutMs = 15000,
) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = page.url();
    if (current && current !== beforeUrl) {
      return { reason: "url_changed" as const, url: current };
    }
    if (domSelector) {
      try {
        await page.waitForLoadState("domcontentloaded");
        const locator = page.locator(domSelector);
        if (
          "waitFor" in locator &&
          typeof (locator as { waitFor?: unknown }).waitFor === "function"
        ) {
          await (locator as { waitFor: (opts?: { timeout?: number }) => Promise<void> }).waitFor({
            timeout: 1000,
          });
        } else if (
          "count" in locator &&
          typeof (locator as { count?: unknown }).count === "function"
        ) {
          const count = await (locator as { count: () => Promise<number> }).count();
          if (count === 0) {
            throw new Error("dom selector not present yet");
          }
        }
        return { reason: "dom_present" as const, url: current };
      } catch {
        // continue polling
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { reason: "timeout" as const, url: page.url() };
};

process.on("unhandledRejection", (reason) =>
  console.error("unhandledRejection", reason),
);
process.on("uncaughtException", (err) =>
  console.error("uncaughtException", err),
);

async function main() {
  const googleApiKey =
    process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!googleApiKey) {
    const record: OutputRecord = {
      timestamp: new Date().toISOString(),
      site: "discounttire",
      search_query: process.env.SEARCH_QUERY ?? "Michelin",
      product_name: null,
      product_url: null,
      initial_price_text: null,
      qualifiers: null,
      final_total_text: null,
      fee_lines: [],
      line_items: [],
      status: "failed",
      notes:
        "Missing Google LLM API key. Set GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
    };
    await appendOutput(record);
    process.exitCode = 1;
    return;
  }

  process.env.GOOGLE_API_KEY = googleApiKey;

  const searchQuery = process.env.SEARCH_QUERY ?? "Michelin";
  const baseOutput = {
    site: "discounttire" as const,
    search_query: searchQuery,
  };

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    cacheDir: ".stagehand_cache",
  });

  let sessionUrl: string | undefined;
  let debugUrl: string | undefined;
  let sessionId: string | undefined;
  const runNotes: string[] = [];
  try {
    await stagehand.init();
    sessionUrl = stagehand.sessionUrl;
    debugUrl = stagehand.debugUrl;
    sessionId = stagehand.sessionId;

    const page =
      stagehand.context.activePage() ??
      stagehand.context.pages()[0] ??
      (await stagehand.context.newPage());

    await stagehand.context.setActivePage(page);

    try {
      await retryStep("navigate home", async () => {
        await page.goto("https://www.discounttire.com/", { waitUntil: "load" });
        await sleep(1500);
      });
    } catch (error) {
      const normalized = formatErrorNotes(runNotes, error);
      console.error("navigate failed", normalized);
      await appendOutput({
        timestamp: new Date().toISOString(),
        ...baseOutput,
        product_name: null,
        product_url: null,
        initial_price_text: null,
        qualifiers: null,
        final_total_text: null,
        fee_lines: [],
        line_items: [],
        sessionUrl,
        debugUrl,
        sessionId,
        status: "failed",
        notes: runNotes.join(" | "),
      });
      process.exitCode = 1;
      return;
    }

    try {
      await retryStep("search", async () => {
        const beforeUrl = page.url();
        await observeAndAct(
          stagehand,
          page,
          `Find the site search input on Discount Tire, type "${searchQuery}", submit the search, and dismiss any popups that block typing if needed.`,
          runNotes,
        );
        const transition = await waitForUrlChangeOrDom(
          page,
          beforeUrl,
          "[data-testid='product-grid'], [data-testid='product-list'], .product-grid, .product-list, .search-results",
          15000,
        );
        runNotes.push(`search_submit transition=${transition.reason}`);
        if (transition.reason === "timeout") {
          throw new BlockedError("search_submit transition timed out");
        }
      });
    } catch (error) {
      const normalized = formatErrorNotes(runNotes, error);
      console.error("search failed", normalized);
      await appendOutput({
        timestamp: new Date().toISOString(),
        ...baseOutput,
        product_name: null,
        product_url: null,
        initial_price_text: null,
        qualifiers: null,
        final_total_text: null,
        fee_lines: [],
        line_items: [],
        sessionUrl,
        debugUrl,
        sessionId,
        status: normalized instanceof BlockedError ? "blocked" : "failed",
        notes: runNotes.join(" | "),
      });
      process.exitCode = 1;
      return;
    }

    let results: z.infer<typeof resultsSchema> | null = null;
    try {
      results = await retryStep("extract results", async () =>
        stagehand.extract({
          schema: resultsSchema,
          instruction:
            "From the search results product cards, extract a list with product name, product URL, the marketed price text, and any qualifiers like per-tire or rebates.",
        }),
      );
    } catch (error) {
      const normalized = formatErrorNotes(runNotes, error);
      console.error("pick products failed", normalized);
      await appendOutput({
        timestamp: new Date().toISOString(),
        ...baseOutput,
        product_name: null,
        product_url: null,
        initial_price_text: null,
        qualifiers: null,
        final_total_text: null,
        fee_lines: [],
        line_items: [],
        sessionUrl,
        debugUrl,
        sessionId,
        status: "failed",
        notes: runNotes.join(" | "),
      });
      process.exitCode = 1;
      return;
    }

    const productsArr = asArray<
      z.infer<typeof resultsSchema>["products"][number]
    >(results?.products);
    if (productsArr.length === 0) {
      runNotes.push("no search results extracted");
      const record: OutputRecord = {
        timestamp: new Date().toISOString(),
        ...baseOutput,
        product_name: null,
        product_url: null,
        initial_price_text: null,
        qualifiers: null,
        final_total_text: null,
        fee_lines: [],
        line_items: [],
        sessionUrl,
        debugUrl,
        sessionId,
        status: "blocked",
        notes: runNotes.join(" | "),
      };
      await appendOutput(record);
      process.exitCode = 1;
      return;
    }

    const seen = new Set<string>();
    const candidates = productsArr
      .map((product) => ({
        ...product,
        product_url: normalizeUrl(product.product_url),
        initial_price_text: product.initial_price_text ?? null,
        qualifiers: product.qualifiers ?? null,
      }))
      .filter((product) => {
        const key = `${product.product_name}::${product.product_url}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, 3);

    if (candidates.length === 0) {
      runNotes.push("no unique search results found");
      const record: OutputRecord = {
        timestamp: new Date().toISOString(),
        ...baseOutput,
        product_name: null,
        product_url: null,
        initial_price_text: null,
        qualifiers: null,
        final_total_text: null,
        fee_lines: [],
        line_items: [],
        sessionUrl,
        debugUrl,
        sessionId,
        status: "blocked",
        notes: runNotes.join(" | "),
      };
      await appendOutput(record);
      process.exitCode = 1;
      return;
    }

    for (const candidate of candidates) {
      const notes: string[] = [];
      let cartExtraction: CartExtraction = {
        final_total_text: null,
        fee_lines: [],
        line_items: [],
      };

      try {
        try {
          await retryStep("navigate product", async () => {
            await page.goto(candidate.product_url, { waitUntil: "load" });
            await sleep(1500);
          });
          await retryStep("add to cart", async () => {
            const beforeUrl = page.url();
            await observeAndAct(
              stagehand,
              page,
              "Click the primary 'Add to cart' or equivalent purchase button for this tire without selecting paid add-ons.",
              notes,
            );
            const transition = await waitForUrlChangeOrDom(
              page,
              beforeUrl,
              "[data-testid='cart-drawer'], .cart-drawer, #cart-drawer, [aria-label='Cart'], text=/added to cart/i",
              15000,
            );
            notes.push(`add_to_cart transition=${transition.reason}`);
            if (transition.reason === "timeout") {
              throw new BlockedError("add_to_cart transition timed out");
            }
          });

          await retryStep("open cart", async () => {
            const beforeUrl = page.url();
            await observeAndAct(
              stagehand,
              page,
              "Open the cart or checkout review page that shows totals without submitting payment.",
              notes,
            );
            const transition = await waitForUrlChangeOrDom(
              page,
              beforeUrl,
              "h1:has-text('Cart'), h2:has-text('Cart'), [data-testid='cart-drawer'], .cart-drawer, #cart-drawer, [aria-label='Cart']",
              15000,
            );
            notes.push(`open_cart transition=${transition.reason}`);
            if (transition.reason === "timeout") {
              throw new BlockedError("open_cart transition timed out");
            }
          });
        } catch (error) {
          const normalized = formatErrorNotes(notes, error);
          console.error("add to cart failed", normalized);
          await appendOutput({
            timestamp: new Date().toISOString(),
            ...baseOutput,
            product_name: candidate.product_name,
            product_url: candidate.product_url,
            initial_price_text: candidate.initial_price_text,
            qualifiers: candidate.qualifiers,
            final_total_text: null,
            fee_lines: [],
            line_items: [],
            sessionUrl,
            debugUrl,
            sessionId,
            status: normalized instanceof BlockedError ? "blocked" : "failed",
            notes: notes.join(" | "),
          });
          continue;
        }

        try {
          cartExtraction = await retryStep("extract cart", async () =>
            stagehand.extract({
              schema: cartSchema,
              instruction:
                "From the cart or checkout review, extract the final total text, any fee lines with labels and amounts, and any line items with labels and amounts.",
            }),
          );
        } catch (error) {
          const normalized = formatErrorNotes(notes, error);
          console.error("extract cart totals failed", normalized);
          await appendOutput({
            timestamp: new Date().toISOString(),
            ...baseOutput,
            product_name: candidate.product_name,
            product_url: candidate.product_url,
            initial_price_text: candidate.initial_price_text,
            qualifiers: candidate.qualifiers,
            final_total_text: null,
            fee_lines: [],
            line_items: [],
            sessionUrl,
            debugUrl,
            sessionId,
            status: "failed",
            notes: notes.join(" | "),
          });
          continue;
        }

        const record: OutputRecord = {
          timestamp: new Date().toISOString(),
          ...baseOutput,
          product_name: candidate.product_name,
          product_url: candidate.product_url,
          initial_price_text: candidate.initial_price_text,
          qualifiers: candidate.qualifiers,
          final_total_text: cartExtraction.final_total_text ?? null,
          fee_lines: cartExtraction.fee_lines ?? [],
          line_items: cartExtraction.line_items ?? [],
          sessionUrl,
          debugUrl,
          sessionId,
          status: "ok",
          notes: notes.length > 0 ? notes.join(" | ") : null,
        };

        await appendOutput(record);
      } catch (error) {
        const normalized = formatErrorNotes(notes, error);
        console.error("product loop failed", normalized);
        await appendOutput({
          timestamp: new Date().toISOString(),
          ...baseOutput,
          product_name: candidate.product_name,
          product_url: candidate.product_url,
          initial_price_text: candidate.initial_price_text,
          qualifiers: candidate.qualifiers,
          final_total_text: null,
          fee_lines: [],
          line_items: [],
          sessionUrl,
          debugUrl,
          sessionId,
          status: "failed",
          notes: notes.join(" | "),
        });
      }
    }
  } catch (error) {
    const normalized = formatErrorNotes(runNotes, error);
    console.error("run failed", normalized);
    await appendOutput({
      timestamp: new Date().toISOString(),
      ...baseOutput,
      product_name: null,
      product_url: null,
      initial_price_text: null,
      qualifiers: null,
      final_total_text: null,
      fee_lines: [],
      line_items: [],
      sessionUrl,
      debugUrl,
      sessionId,
      status: "failed",
      notes: runNotes.join(" | "),
    });
    process.exitCode = 1;
  } finally {
    await stagehand.close();
  }
}

main().catch(async (error) => {
  const notes: string[] = [];
  const normalized = formatErrorNotes(notes, error);
  console.error("FATAL", normalized);
  await appendOutput({
    timestamp: new Date().toISOString(),
    site: "discounttire",
    search_query: process.env.SEARCH_QUERY ?? "Michelin",
    product_name: null,
    product_url: null,
    initial_price_text: null,
    qualifiers: null,
    final_total_text: null,
    fee_lines: [],
    line_items: [],
    status: "failed",
    notes: notes.join(" | "),
  });
  process.exitCode = 1;
});
