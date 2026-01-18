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

const isBlockedObservedAction = (description: string) => {
  const lowered = description.toLowerCase();
  return [
    "enable accessibility",
    "skip to main content",
    "accessibility policy",
    "usablenet",
    "tire price guide",
    "send to phone",
    "schedule appointment",
  ].some((phrase) => lowered.includes(phrase));
};

const pickObservedAction = (observed: unknown[], notes: string[]) => {
  const actions = asArray<{ selector?: string; description?: string }>(observed);
  if (actions.length === 0) {
    return null;
  }
  const filtered = actions.filter(
    (action) =>
      !action.description || !isBlockedObservedAction(action.description),
  );
  if (filtered.length === 0) {
    notes.push(
      `observe returned only blocked actions: ${actions
        .map((action) => action.description ?? "unknown")
        .join(", ")}`,
    );
    return null;
  }
  return filtered[0];
};

const observeAndAct = async (
  stagehand: Stagehand,
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  instruction: string,
  notes: string[],
) => {
  const observed = (await stagehand.observe({ instruction })) ?? [];
  if (observed.length === 0) {
    notes.push(`observe returned empty list for: ${instruction}`);
  }
  const action = pickObservedAction(observed, notes);

  if (!action) {
    notes.push(`observe returned no usable actions for: ${instruction}`);
    await stagehand.act(`Perform the action described: ${instruction}`);
    return false;
  }

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

const waitForLocatorVisible = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  selector: string,
  timeoutMs: number,
) => {
  const locator = page.locator(selector).first();
  if (
    "waitFor" in locator &&
    typeof (locator as { waitFor?: unknown }).waitFor === "function"
  ) {
    try {
      await (
        locator as {
          waitFor: (opts?: { state?: "visible"; timeout?: number }) => Promise<void>;
        }
      ).waitFor({ state: "visible", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (
        "count" in locator &&
        typeof (locator as { count?: unknown }).count === "function"
      ) {
        const count = await (locator as { count: () => Promise<number> }).count();
        if (count > 0) {
          return true;
        }
      } else if (selector.startsWith("text=") || selector.startsWith("text=/")) {
        const content = await page.textContent("body");
        if (content && content.match(/results/i)) {
          return true;
        }
      }
    } catch {
      // ignore and continue polling
    }
    await sleep(250);
  }
  return false;
};

const locatorVisibleNow = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  selector: string,
) => {
  try {
    const locator = page.locator(selector).first();
    if (
      "isVisible" in locator &&
      typeof (locator as { isVisible?: unknown }).isVisible === "function"
    ) {
      return await (locator as { isVisible: () => Promise<boolean> }).isVisible();
    }
  } catch {
    return false;
  }
  return false;
};

const findVisibleSelector = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  selectors: string[],
) => {
  for (const selector of selectors) {
    if (await locatorVisibleNow(page, selector)) {
      return selector;
    }
  }
  return null;
};

const resultsHeadingVisible = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
) => {
  try {
    const locator = page
      .locator("h1, h2, h3")
      .filter({ hasText: /results|tires/i })
      .first();
    if (
      "isVisible" in locator &&
      typeof (locator as { isVisible?: unknown }).isVisible === "function"
    ) {
      return await (locator as { isVisible: () => Promise<boolean> }).isVisible();
    }
  } catch {
    return false;
  }
  return false;
};

const waitForSearchResults = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  timeoutMs: number,
) => {
  const resultSelectors = [
    "[data-testid*='results']",
    "[data-testid*='product']",
    ".results",
    ".search-results",
    ".product-grid",
    ".product-list",
    ".product-card",
    "[class*='Results']",
    "[class*='ProductGrid']",
  ];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await locatorCountAtLeast(page, "a[href*='/tires']", 3)) {
      return "links:/tires";
    }
    const container = await findVisibleSelector(page, resultSelectors);
    if (container) {
      return `results_container:${container}`;
    }
    if (await resultsHeadingVisible(page)) {
      return "results_heading:text";
    }
    await sleep(250);
  }
  return null;
};

const locatorCountAtLeast = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  selector: string,
  minCount: number,
) => {
  try {
    const count = await page.locator(selector).count();
    return count >= minCount;
  } catch {
    return false;
  }
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
      const visible = await waitForLocatorVisible(page, domSelector, 1000);
      if (visible) {
        return { reason: "dom_present" as const, url: current };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { reason: "timeout" as const, url: page.url() };
};

const performSearchSubmitStep2 = async (
  stagehand: Stagehand,
  notes: string[],
) => {
  try {
    await stagehand.act("press Enter in the search box");
    notes.push("search_submit_step2=enter");
    return "enter";
  } catch (error) {
    notes.push(
      `search_submit_step2_enter_failed=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await stagehand.act("click the search submit icon next to the search box");
  notes.push("search_submit_step2=search_icon");
  return "search_icon";
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
      status: "blocked",
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
        status: "blocked",
        notes: runNotes.join(" | "),
      });
      process.exitCode = 1;
      return;
    }

    {
      let searchOk = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const observeInstruction =
            "Find the main search input in the site header with placeholder 'What can we help you find?' Return the clickable element for focusing the search input.";
          const observed = (await stagehand.observe({
            instruction: observeInstruction,
          })) ?? [];
          if (observed.length === 0) {
            runNotes.push(
              "search observe returned empty list, falling back to direct act",
            );
            await stagehand.act(
              "Click the search box in the header that says 'What can we help you find?'",
            );
          } else {
            let action = pickObservedAction(observed, runNotes);
            if (!action) {
              const refinedObserved = (await stagehand.observe({
                instruction:
                  "Focus the header search input with placeholder 'What can we help you find?' Ignore accessibility links and policy banners.",
              })) ?? [];
              if (refinedObserved.length === 0) {
                runNotes.push(
                  "refined search observe returned empty list, falling back to direct act",
                );
                await stagehand.act(
                  "Click the search box in the header that says 'What can we help you find?'",
                );
              } else {
                action = pickObservedAction(refinedObserved, runNotes);
              }
            }
            if (!action) {
              runNotes.push(
                "search observe returned no usable actions after refinement",
              );
              await stagehand.act(
                "Click the search box in the header that says 'What can we help you find?'",
              );
            } else {
              await stagehand.act(action);
            }
          }
          const fillObserved = (await stagehand.observe({
            instruction: `Type "${searchQuery}" into the search input`,
          })) ?? [];
          const fillAction = pickObservedAction(fillObserved, runNotes);
          if (!fillAction) {
            runNotes.push("search fill observe returned no usable actions");
            await stagehand.act(
              `Type "${searchQuery}" into the search input`,
            );
            await performSearchSubmitStep2(stagehand, runNotes);
          } else {
            await stagehand.act(fillAction);
            const method = (fillAction as { method?: string }).method?.toLowerCase();
            if (method === "fill" || method === "type") {
              const twoStep = (fillAction as { twoStep?: boolean }).twoStep === true;
              if (twoStep) {
                runNotes.push("search_fill_two_step=true");
              }
              await performSearchSubmitStep2(stagehand, runNotes);
            }
          }
          const searchResultReason = await waitForSearchResults(page, 15000);
          searchOk = Boolean(searchResultReason);
          runNotes.push(
            searchResultReason
              ? `search_submit success=${searchResultReason}`
              : "search_submit timeout",
          );
          if (searchOk) {
            break;
          }
        } catch (error) {
          runNotes.push(
            `search attempt ${attempt + 1} error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (attempt < 2) {
          await sleep(1000);
        }
      }

      if (!searchOk) {
        runNotes.push("search_submit_dom_timeout");
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
          status: "blocked",
          notes: runNotes.join(" | "),
        });
        process.exitCode = 1;
        return;
      }
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
        status: "blocked",
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
            status: "blocked",
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
          status: "blocked",
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
      status: "blocked",
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
    status: "blocked",
    notes: notes.join(" | "),
  });
  process.exitCode = 1;
});
