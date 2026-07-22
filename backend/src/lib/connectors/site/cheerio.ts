// Read-only site connector. Fetches a public URL, parses with cheerio, returns
// a structured CrawledPage. No writes — `canWriteX` is false across the board.
//
// Used by Step 3's `crawl_site` and `audit_seo` tools. Future write-capable
// site connectors (WordPress, GitHub-MDX, Webflow) implement the same
// SiteConnector interface.

import * as cheerio from "cheerio";
import type {
  CompetitorPageFacts,
  CrawledPage,
  SiteCapabilities,
  SiteConnector,
} from "../types";

const CAPABILITIES: SiteCapabilities = {
  canCrawl: true,
  canReadCompetitor: true,
  canScanSource: false,
  canAnalyzeRepoStructure: false,
  canWriteMeta: false,
  canWriteCopy: false,
  canPublishPosts: false,
  canFixAltText: false,
  canFixPageMetadata: false,
  canImproveVisibleContent: false,
  canRewriteVisibleCopy: false,
  canImproveCtas: false,
  canAddFaqSections: false,
  canApplyVisualUpgrades: false,
  canApplyProductionSiteUpgrades: false,
  canApplyInteractiveConversionUpgrades: false,
  writesViaPR: false,
};

const FETCH_TIMEOUT_MS = 15_000;
// Use a realistic Chrome fingerprint instead of "MarketPilotAI/1.0". A custom
// UA gets us blocked by Cloudflare-style bot protection immediately; mimicking
// a real Chrome on Windows passes basic detection and crawls most public sites
// that the original UA couldn't. Headless Playwright is the next escalation
// for the sites this still can't crack (see playwright connector).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Headers a real Chrome sends — order and presence both matter to some WAFs.
function browserHeaders(): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

export const cheerioSiteConnector: SiteConnector = {
  type: "site:cheerio",
  capabilities: CAPABILITIES,

  async crawl(url: string): Promise<CrawledPage> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`crawl: url must start with http(s)://, got: ${url}`);
    }

    const response = await fetch(url, {
      headers: browserHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });

    const html = await response.text();
    const $ = cheerio.load(html);
    const host = safeHost(url);

    // Collect headings.
    const h1s = $("h1")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    const h2s = $("h2")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

    // Image alt audit.
    const imagesWithoutAlt: string[] = [];
    $("img").each((_, el) => {
      const alt = $(el).attr("alt");
      if (alt === undefined || alt.trim() === "") {
        const src = $(el).attr("src") ?? "(no src)";
        imagesWithoutAlt.push(src);
      }
    });

    // Link audit.
    let internal = 0;
    let external = 0;
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
      if (href.startsWith("/") || (host && href.includes(host))) internal++;
      else if (/^https?:\/\//i.test(href)) external++;
    });

    // Schema markup.
    const schemaTypes: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const t = json["@type"];
        if (typeof t === "string") schemaTypes.push(t);
        else if (Array.isArray(t)) for (const s of t) if (typeof s === "string") schemaTypes.push(s);
      } catch {
        // ignore unparseable schema blocks
      }
    });

    // Body word count — strip script/style first.
    $("script,style,noscript").remove();
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const wordCount = bodyText ? bodyText.split(" ").length : 0;

    return {
      url,
      status: response.status,
      title: $("title").first().text().trim() || undefined,
      metaDescription:
        $('meta[name="description"]').attr("content")?.trim() || undefined,
      h1s,
      h2s,
      imagesWithoutAlt,
      internalLinks: internal,
      externalLinks: external,
      wordCount,
      hasJsonLdSchema: schemaTypes.length > 0,
      schemaTypes: Array.from(new Set(schemaTypes)),
      canonical: $('link[rel="canonical"]').attr("href")?.trim() || undefined,
      language: $("html").attr("lang")?.trim() || undefined,
      viewportMeta: $('meta[name="viewport"]').attr("content")?.trim() || undefined,
      fetchedAt: new Date().toISOString(),
    };
  },

  // Competitor-research read. Extracts the fields a marketing analyst would
  // care about — positioning, CTAs, pricing signals, social proof — rather
  // than the SEO fields `crawl` returns. Same underlying fetch + Cheerio, but
  // a different question.
  async crawlCompetitor(url: string): Promise<CompetitorPageFacts> {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`crawlCompetitor: url must start with http(s)://, got: ${url}`);
    }

    // Two-tier fetch strategy.
    //   Tier 1: plain `fetch` with realistic Chrome headers. Fast (~500ms),
    //           free, no browser to spin up. Wins ~80% of public sites.
    //   Tier 2: headless Chromium via Playwright. Slower (~3-6s) but defeats
    //           Cloudflare bot management, Akamai, DataDome, etc. — the cases
    //           tier 1 can't crack. Only fires when tier 1 detects a block.
    // The order matters: we don't want to pay browser-startup cost on every
    // crawl when 80% of them work with a $0.0001 fetch.
    let html: string;
    let status: number;
    try {
      const tier1 = await fetchHtml(url);
      html = tier1.html;
      status = tier1.status;
      // 403/429 or a recognized block-page = WAF blocked the fetch. Escalate.
      if (status === 403 || status === 429 || detectBotBlock(html)) {
        throw new Error("tier1-blocked");
      }
    } catch (tier1Err) {
      // Tier 1 failed (block or network error). Try Playwright.
      const tier2 = await fetchHtmlWithBrowser(url).catch((err) => {
        // Surface the most useful error. If tier 1 was an explicit block and
        // tier 2 also failed, the underlying block is the more useful signal.
        const tier1Msg = tier1Err instanceof Error ? tier1Err.message : String(tier1Err);
        const tier2Msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Tier 1 fetch failed (${tier1Msg}); tier 2 (headless browser) also failed: ${tier2Msg}`,
        );
      });
      html = tier2.html;
      status = tier2.status;
      // Even a headless browser can be blocked (enterprise Cloudflare, etc.).
      // If tier 2 ALSO returns a block-page, give up honestly.
      if (status === 403 || status === 429 || detectBotBlock(html)) {
        throw new Error(
          `Site appears to be behind aggressive bot protection — headless browser was also blocked. Crawl returned no analyzable content.`,
        );
      }
    }

    const $ = cheerio.load(html);
    const response = { status };

    const ogTitle = metaContent($, 'meta[property="og:title"]');
    const ogDescription = metaContent($, 'meta[property="og:description"]');
    const ogSiteName = metaContent($, 'meta[property="og:site_name"]');
    const applicationName = metaContent($, 'meta[name="application-name"]');
    const pageTitle = $("title").first().text().trim() || undefined;
    const metaDescription = metaContent($, 'meta[name="description"]');

    const brandName =
      ogSiteName || applicationName || firstWord(pageTitle) || hostnameBrand(url);

    // Hero: first <h1>, then first meaningful <p> following it.
    const heroH1El = $("h1").first();
    const headline = textOrUndefined(heroH1El);
    let subhead: string | undefined;
    if (heroH1El.length > 0) {
      const nextParagraph = heroH1El
        .nextAll("p")
        .filter((_, el) => $(el).text().trim().length >= 20)
        .first();
      subhead = textOrUndefined(nextParagraph);
      if (!subhead) {
        // Look at the parent's siblings — heroes often wrap h1 in a container.
        const parentParagraph = heroH1El
          .parent()
          .find("p")
          .filter((_, el) => $(el).text().trim().length >= 20)
          .first();
        subhead = textOrUndefined(parentParagraph);
      }
    }

    // Nav: top-of-page links. Prefer <nav> elements; fall back to <header> links.
    const navItems = collectNavItems($);

    // CTAs: visible <button> + anchor links that look like CTAs.
    const ctas = collectCtas($);

    // Pricing signals: any element text that mentions money or pricing keywords.
    const pricingSignals = collectPricingSignals($);

    // Social proof: testimonial blocks, "trusted by" copy, customer logo alt text.
    const socialProof = collectSocialProof($);

    // Footer links: text from <footer> anchors, deduped.
    const footerLinks = collectFooterLinks($);

    return {
      url,
      status: response.status,
      brandName,
      hero: { headline, subhead },
      navItems,
      ctas,
      pricingSignals,
      socialProof,
      footerLinks,
      metaDescription,
      ogTitle,
      ogDescription,
      language: $("html").attr("lang")?.trim() || undefined,
      fetchedAt: new Date().toISOString(),
    };
  },
};

// ---------- HTML fetch tiers ----------

// Tier 1: plain `fetch` with realistic Chrome headers. Cheap and fast.
async function fetchHtml(url: string): Promise<{ html: string; status: number }> {
  const response = await fetch(url, {
    headers: browserHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  const html = await response.text();
  return { html, status: response.status };
}

// Tier 2: headless Chromium via Playwright. The browser is reused across calls
// (lazy singleton) — startup is ~1.5s on cold boot, but ~0ms when reusing.
// Imports are inside the function to avoid loading the Playwright runtime
// for users who never trigger tier 2.
const PLAYWRIGHT_TIMEOUT_MS = 30_000;
let browserPromise: Promise<import("playwright").Browser> | null = null;

async function getBrowser(): Promise<import("playwright").Browser> {
  if (!browserPromise) {
    const { chromium } = await import("playwright");
    browserPromise = chromium.launch({
      headless: true,
      // These args reduce headless detection surface. Not a stealth plugin —
      // just removing the most obvious "automation" tells.
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserPromise;
}

async function fetchHtmlWithBrowser(
  url: string,
): Promise<{ html: string; status: number }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
    },
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PLAYWRIGHT_TIMEOUT_MS,
    });
    // Brief settle window — many anti-bot challenges only resolve after a few
    // hundred ms of JS execution. Not waiting can return the challenge page.
    await page.waitForTimeout(1500);
    const html = await page.content();
    const status = response?.status() ?? 0;
    return { html, status };
  } finally {
    // Always close the page + context so we don't leak memory across calls.
    // The shared `browser` stays open for reuse.
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

// Best-effort cleanup hook so the browser closes when the process exits.
// Without this, dev-server restarts can leak Chromium processes.
let shutdownRegistered = false;
function registerBrowserShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const close = async () => {
    if (browserPromise) {
      const b = await browserPromise.catch(() => null);
      browserPromise = null;
      await b?.close().catch(() => undefined);
    }
  };
  process.on("beforeExit", () => void close());
  process.on("SIGINT", () => void close().then(() => process.exit(0)));
  process.on("SIGTERM", () => void close().then(() => process.exit(0)));
}
registerBrowserShutdown();

// ---------- Competitor-read helpers (kept local to this connector) ----------

type CheerioAPI = ReturnType<typeof cheerio.load>;
type CheerioElement = ReturnType<CheerioAPI>;

function metaContent($: CheerioAPI, selector: string): string | undefined {
  const v = $(selector).attr("content")?.trim();
  return v && v.length > 0 ? v : undefined;
}

function textOrUndefined(el: CheerioElement): string | undefined {
  const t = el.text().replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : undefined;
}

function firstWord(s: string | undefined): string | undefined {
  if (!s) return undefined;
  // Page titles often look like "Brand — Tagline" or "Brand | Page". Take the
  // part before the separator as a brand guess.
  const split = s.split(/\s+[|—–-]\s+/)[0]?.trim();
  return split && split.length > 0 ? split : undefined;
}

function hostnameBrand(url: string): string | undefined {
  const host = safeHost(url)?.replace(/^www\./, "");
  if (!host) return undefined;
  const root = host.split(".")[0];
  if (!root) return host;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

const MAX_NAV = 12;
const MAX_CTAS = 8;
const MAX_PRICING = 6;
const MAX_SOCIAL = 6;
const MAX_FOOTER = 16;
const MIN_TEXT = 2;
const MAX_TEXT = 140;

function collectNavItems($: CheerioAPI): string[] {
  const items: string[] = [];
  $("nav a, header nav a, header a").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < MIN_TEXT || text.length > 40) return;
    items.push(text);
  });
  return dedupeShortlist(items, MAX_NAV);
}

const CTA_HINTS = [
  "get started",
  "start free",
  "start for free",
  "try free",
  "try it",
  "try for free",
  "sign up",
  "signup",
  "log in",
  "login",
  "book a demo",
  "book demo",
  "request demo",
  "request a demo",
  "see demo",
  "talk to sales",
  "contact sales",
  "buy",
  "subscribe",
  "join",
  "download",
  "install",
  "watch demo",
  "learn more",
];

function collectCtas($: CheerioAPI): string[] {
  const items: string[] = [];
  $("button, a[href]").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < MIN_TEXT || text.length > 40) return;
    const lower = text.toLowerCase();
    const looksLikeCta =
      CTA_HINTS.some((hint) => lower.includes(hint)) ||
      /^(start|try|get|book|request|join|buy|download|install)\b/i.test(text);
    if (looksLikeCta) items.push(text);
  });
  return dedupeShortlist(items, MAX_CTAS);
}

const PRICING_PATTERNS: RegExp[] = [
  /\$[\s]?\d/,                       // "$10", "$ 10"
  /\b\d+\s*(?:\/|per)\s*(?:mo|month|year|yr|user|seat)\b/i,
  /\bfree\b/i,
  /\bstarter\b/i,
  /\bpro\b/i,
  /\bbusiness\b/i,
  /\benterprise\b/i,
  /\bpricing\b/i,
  /\busd\b/i,
];

function collectPricingSignals($: CheerioAPI): string[] {
  const items: string[] = [];
  $("p, li, h2, h3, span, div").each((_, el) => {
    if (items.length >= MAX_PRICING * 4) return false;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > MAX_TEXT) return;
    if (!PRICING_PATTERNS.some((pattern) => pattern.test(text))) return;
    items.push(text);
    return;
  });
  return dedupeShortlist(items, MAX_PRICING);
}

const SOCIAL_PROOF_HINTS = [
  "trusted by",
  "loved by",
  "used by",
  "join thousands",
  "join 10,000",
  "happy customers",
  "rated",
  "featured in",
  "as seen in",
  "review",
  "testimonial",
  "customers",
];

function collectSocialProof($: CheerioAPI): string[] {
  const items: string[] = [];

  // 1. Customer logo strips — alt text on <img> within sections that mention "customers"/"trusted by".
  $("img[alt]").each((_, el) => {
    const alt = $(el).attr("alt")?.trim() ?? "";
    if (alt.length < MIN_TEXT || alt.length > 40) return;
    const parentText = $(el).closest("section, div").text().toLowerCase();
    if (parentText.includes("trusted") || parentText.includes("customers") || parentText.includes("logos")) {
      items.push(`Logo: ${alt}`);
    }
  });

  // 2. Text blocks mentioning social-proof keywords.
  $("p, h2, h3, blockquote, span").each((_, el) => {
    if (items.length >= MAX_SOCIAL * 4) return false;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 10 || text.length > MAX_TEXT) return;
    const lower = text.toLowerCase();
    if (SOCIAL_PROOF_HINTS.some((hint) => lower.includes(hint))) {
      items.push(text);
    }
    return;
  });

  return dedupeShortlist(items, MAX_SOCIAL);
}

function collectFooterLinks($: CheerioAPI): string[] {
  const items: string[] = [];
  $("footer a").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < MIN_TEXT || text.length > 40) return;
    items.push(text);
  });
  return dedupeShortlist(items, MAX_FOOTER);
}

function dedupeShortlist(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

// Detect Cloudflare / Akamai / PerimeterX / DataDome / generic bot-challenge
// pages. Returns a short signal string when blocked, undefined otherwise.
// We check the raw HTML (case-insensitive) for marker strings that only
// appear on challenge/block pages, not on real product pages. Order matters
// only for the returned label.
function detectBotBlock(html: string): string | undefined {
  if (!html || html.length < 50) return "empty-response";

  const lower = html.toLowerCase();

  // Cloudflare challenge / "Just a moment..."
  if (
    lower.includes("cf-chl-bypass") ||
    lower.includes("cf_chl_opt") ||
    lower.includes("__cf_chl_") ||
    (lower.includes("just a moment") && lower.includes("cloudflare")) ||
    lower.includes("attention required! | cloudflare")
  ) {
    return "cloudflare-challenge";
  }

  // Generic "checking your browser" interstitials
  if (
    lower.includes("checking your browser before accessing") ||
    lower.includes("checking if the site connection is secure") ||
    lower.includes("enable javascript and cookies to continue")
  ) {
    return "browser-check";
  }

  // Akamai / Imperva / generic WAF blocks
  if (
    lower.includes("access denied") &&
    (lower.includes("reference number") || lower.includes("incapsula") || lower.includes("akamai"))
  ) {
    return "waf-block";
  }

  // PerimeterX / HUMAN bot block
  if (lower.includes("px-captcha") || lower.includes("perimeterx") || lower.includes("/_px/")) {
    return "perimeterx-block";
  }

  // DataDome
  if (lower.includes("datadome") && lower.includes("captcha")) {
    return "datadome-block";
  }

  // Generic captcha-only page (very short page that is mostly a captcha)
  if (
    html.length < 4000 &&
    (lower.includes("recaptcha") || lower.includes("hcaptcha") || lower.includes("captcha")) &&
    !lower.includes("<main") &&
    !lower.includes("<article")
  ) {
    return "captcha-page";
  }

  return undefined;
}
