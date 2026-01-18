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

const blockedActionDescriptionRegex =
  /accessibility|skip to main|usableNet|tire price guide|free services|policy|send to phone|schedule appointment/i;

type ObserveThenActOptions = {
  fallbackInstruction: string;
  filterBadActionDescriptions?: boolean;
  maxAttempts?: number;
};

const observeThenAct = async (
  stagehand: Stagehand,
  prompt: string,
  options: ObserveThenActOptions,
) => {
  const notes: string[] = [];
  const maxAttempts = options.maxAttempts ?? 2;
  const shouldFilter = options.filterBadActionDescriptions ?? true;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let observed: unknown[] = [];
    try {
      observed = (await stagehand.observe({ instruction: prompt })) ?? [];
    } catch (error) {
      notes.push(
        `observe_failed=${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actions = asArray<{ description?: string; method?: string; twoStep?: boolean }>(
      observed,
    );
    const filtered = shouldFilter
      ? actions.filter(
          (action) =>
            !action.description ||
            !blockedActionDescriptionRegex.test(action.description),
        )
      : actions;

    if (filtered.length === 0) {
      notes.push(`observe_empty_or_filtered attempt=${attempt + 1}`);
      try {
        await stagehand.act(options.fallbackInstruction);
        return { ok: true, notes };
      } catch (error) {
        notes.push(
          `fallback_act_failed=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (attempt < maxAttempts - 1) {
          await sleep(1000);
          continue;
        }
        return { ok: false, notes };
      }
    }

    const action = filtered[0];
    try {
      await stagehand.act(action);
      const method = action.method?.toLowerCase();
      if (action.twoStep === true && (method === "fill" || method === "type")) {
        try {
          await stagehand.act("Press Enter in the focused input");
          notes.push("observeThenAct_step2=enter");
        } catch (error) {
          notes.push(
            `observeThenAct_step2_enter_failed=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          try {
            await stagehand.act("Click the search icon if present");
            notes.push("observeThenAct_step2=search_icon");
          } catch (secondError) {
            notes.push(
              `observeThenAct_step2_icon_failed=${
                secondError instanceof Error
                  ? secondError.message
                  : String(secondError)
              }`,
            );
          }
        }
      }
      return { ok: true, notes };
    } catch (error) {
      notes.push(
        `act_failed attempt=${attempt + 1}=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (attempt < maxAttempts - 1) {
        await sleep(1000);
        continue;
      }
      return { ok: false, notes };
    }
  }

  return { ok: false, notes };
};

type WaitForStateOptions = {
  selectorsAny?: string[];
  minCounts?: { selector: string; count: number }[];
  requireUrlChangeFrom?: string;
  urlIncludesAny?: string[];
  timeoutMs?: number;
};

const waitForState = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  options: WaitForStateOptions,
) => {
  const selectorsAny = options.selectorsAny ?? [];
  const minCounts = options.minCounts ?? [];
  const requireUrlChangeFrom = options.requireUrlChangeFrom;
  const urlIncludesAny = options.urlIncludesAny ?? [];
  const timeoutMs = options.timeoutMs ?? 15000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (requireUrlChangeFrom) {
      try {
        if (page.url() !== requireUrlChangeFrom) {
          return "urlChanged";
        }
      } catch {
        // ignore and continue polling
      }
    }

    if (urlIncludesAny.length > 0) {
      const currentUrl = page.url();
      if (urlIncludesAny.some((fragment) => currentUrl.includes(fragment))) {
        return "urlIncludes";
      }
    }

    for (const selector of selectorsAny) {
      if (selector.startsWith("text=") || selector.startsWith("text=/")) {
        try {
          const content = await page.textContent("body");
          let pattern: RegExp | null = null;
          let needle: string | null = null;
          if (selector.startsWith("text=/")) {
            const lastSlash = selector.lastIndexOf("/");
            if (lastSlash > 5) {
              const body = selector.slice(6, lastSlash);
              const flags = selector.slice(lastSlash + 1) || "i";
              pattern = new RegExp(body, flags);
            }
          } else {
            needle = selector.slice(5);
          }
          if (
            (pattern && content && pattern.test(content)) ||
            (needle && content && content.includes(needle))
          ) {
            return `text:${selector}`;
          }
        } catch {
          // ignore and continue polling
        }
        continue;
      }
      try {
        const count = await page.locator(selector).count();
        if (count > 0) {
          return `selectorsAny:${selector}`;
        }
      } catch {
        // ignore and continue polling
      }
    }

    for (const { selector, count } of minCounts) {
      try {
        const found = await page.locator(selector).count();
        if (found >= count) {
          return `minCounts:${selector}`;
        }
      } catch {
        // ignore and continue polling
      }
    }

    await sleep(250);
  }

  return null;
};

const productCardSelector =
  "[data-testid*='product'], .product-card, [class*='ProductCard']";
const searchResultSelectors = [
  productCardSelector,
  "[data-testid*='results']",
  ".search-results",
  ".product-grid",
  ".product-list",
  "[class*='ProductGrid']",
];

const attemptSearch = async (
  page: Awaited<ReturnType<Stagehand["context"]["newPage"]>>,
  stagehand: Stagehand,
  searchQuery: string,
  runNotes: string[],
) => {
  const initialUrl = page.url();
  const searchInput = page
    .getByPlaceholder("What can we help you find?")
    .first();

  try {
    await searchInput.waitFor({ state: "visible", timeout: 5000 });
    await searchInput.click({ timeout: 3000 });
    await searchInput.fill(searchQuery, { timeout: 3000 });
    await searchInput.press("Enter", { timeout: 3000 });
    runNotes.push("search_submit=playwright_input");
  } catch (error) {
    runNotes.push(
      `search_submit_playwright_failed=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    await stagehand.act(
      `Click the main header search input with placeholder "What can we help you find?", type "${searchQuery}", and press Enter.`,
    );
    runNotes.push("search_submit=stagehand_fallback");
  }

  const urlChangeReason = await waitForState(page, {
    requireUrlChangeFrom: initialUrl,
    timeoutMs: 15000,
  });

  if (!urlChangeReason) {
    runNotes.push("search_submit_url_timeout");
    return false;
  }

  const resultsReason = await waitForState(page, {
    selectorsAny: searchResultSelectors,
    minCounts: [{ selector: productCardSelector, count: 1 }],
    timeoutMs: 15000,
  });
  runNotes.push(
    resultsReason
      ? `search_submit_results=${resultsReason}`
      : "search_submit_results_timeout",
  );
  return Boolean(resultsReason);
};

process.on("unhandledRejection", (reason) =>
  console.error(
    "unhandledRejection",
    reason instanceof Error ? reason.stack ?? reason : reason,
  ),
);
process.on("uncaughtException", (err) =>
  console.error(
    "uncaughtException",
    err instanceof Error ? err.stack ?? err : err,
  ),
);

let lastSessionUrl: string | undefined;
let lastDebugUrl: string | undefined;
let lastSessionId: string | undefined;

async function main() {
  const googleApiKey =
    process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  if (!googleApiKey) {
    throw new Error(
      "Missing Google LLM API key. Set GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
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
    lastSessionUrl = sessionUrl;
    lastDebugUrl = debugUrl;
    lastSessionId = sessionId;

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
      return;
    }

    let results: z.infer<typeof resultsSchema> | null = null;
    let productsArr: z.infer<typeof resultsSchema>["products"] = [];
    let searchOk = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const searchSucceeded = await attemptSearch(
          page,
          stagehand,
          searchQuery,
          runNotes,
        );
        if (!searchSucceeded) {
          runNotes.push(`search_attempt_failed=${attempt + 1}`);
          if (attempt < 2) {
            await sleep(1000);
            continue;
          }
          break;
        }

        results = await retryStep("extract results", async () =>
          stagehand.extract({
            schema: resultsSchema,
            instruction:
              "From the search results product cards, extract product name, product URL, the marketed price text, and qualifiers like per-tire or rebates.",
          }),
        );
        productsArr = asArray<
          z.infer<typeof resultsSchema>["products"][number]
        >(results?.products);
        if (productsArr.length > 0) {
          searchOk = true;
          break;
        }
        runNotes.push(
          `search_attempt_no_products_extracted=${attempt + 1}`,
        );
      } catch (error) {
        runNotes.push(
          `search attempt ${attempt + 1} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (attempt < 2) {
        await sleep(1000);
        await page.goto("https://www.discounttire.com/", { waitUntil: "load" });
        await sleep(1500);
      }
    }

    if (!searchOk) {
      runNotes.push("search_submit_failed_or_empty");
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
      .slice(0, 30);

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
      return;
    }

    const SUCCESS_TARGET = 5;
    const MAX_ATTEMPTS = 30;
    let successCount = 0;
    let attempts = 0;

    for (const candidate of candidates) {
      if (successCount >= SUCCESS_TARGET || attempts >= MAX_ATTEMPTS) {
        break;
      }
      attempts += 1;
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
            const addResult = await observeThenAct(
              stagehand,
              "Click the primary 'Add to cart' button for this tire product page. Avoid optional protection add-ons.",
              {
                fallbackInstruction:
                  "Click the main Add to cart button on the product page without selecting add-ons.",
              },
            );
            notes.push(...addResult.notes);
            if (!addResult.ok) {
              throw new BlockedError("add_to_cart action failed");
            }
            const transition = await waitForState(page, {
              selectorsAny: [
                "[data-testid='cart-drawer']",
                ".cart-drawer",
                "#cart-drawer",
                "[aria-label='Cart']",
                "text=/added to cart/i",
                "text=/cart/i",
              ],
              timeoutMs: 15000,
            });
            notes.push(`add_to_cart transition=${transition ?? "timeout"}`);
            if (!transition) {
              throw new BlockedError("add_to_cart transition timed out");
            }
          });

          await retryStep("open cart", async () => {
            const openResult = await observeThenAct(
              stagehand,
              "Open the cart drawer or cart page that shows totals without submitting payment.",
              {
                fallbackInstruction:
                  "Open the cart drawer or cart page showing totals.",
              },
            );
            notes.push(...openResult.notes);
            if (!openResult.ok) {
              throw new BlockedError("open_cart action failed");
            }
            const transition = await waitForState(page, {
              selectorsAny: [
                "h1:has-text('Cart')",
                "h2:has-text('Cart')",
                "[data-testid='cart-drawer']",
                ".cart-drawer",
                "#cart-drawer",
                "[aria-label='Cart']",
                "text=/cart/i",
              ],
              timeoutMs: 15000,
            });
            notes.push(`open_cart transition=${transition ?? "timeout"}`);
            if (!transition) {
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
        successCount += 1;
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
          status: normalized instanceof BlockedError ? "blocked" : "failed",
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
    sessionUrl: lastSessionUrl,
    debugUrl: lastDebugUrl,
    sessionId: lastSessionId,
    status: "fatal",
    notes: notes.join(" | "),
  });
  process.exit(1);
});
