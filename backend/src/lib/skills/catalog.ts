// Skill Catalog — the single source of truth for the 41 marketing skills.
//
// Reading order:
//   1. types.ts — the shape of one entry
//   2. this file — the 41 entries
//   3. allowedToolsFor() / getSkill() / listSkills() — the API the rest of
//      the app calls into
//
// `seo-audit` is the fully-filled executable example. The other 40 are honest
// stubs marked `draft-only`: they now collect skill-specific briefs, but still
// run through the generic agent loop with DEFAULT_TOOLS until they're matured
// one-by-one in Step 4.
//
// Replaces:
//   - backend/src/lib/skills/manifest.ts (re-exported from here for now)
//   - frontend hardcoded skillOptions list

import type { BriefField, SkillCatalogEntry } from "./types";

type BriefFields = BriefField[];

function textField(
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  helpText?: string,
): BriefField {
  return { key, label, type: "text", required, placeholder, helpText };
}

function textareaField(
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  helpText?: string,
): BriefField {
  return { key, label, type: "textarea", required, placeholder, helpText };
}

function urlField(
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  helpText?: string,
): BriefField {
  return { key, label, type: "url", required, placeholder, helpText };
}

function selectField(
  key: string,
  label: string,
  required: boolean,
  options: string[],
  helpText?: string,
): BriefField {
  return { key, label, type: "select", required, options, helpText };
}

function numberField(
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  helpText?: string,
): BriefField {
  return { key, label, type: "number", required, placeholder, helpText };
}

const skillBriefFields: Record<string, BriefFields> = {
  "ai-seo": [
    urlField("productUrl", "Product or Content URL", true, "https://example.com"),
    textareaField("targetQueries", "Target AI Search Questions", true, "What should ChatGPT / Perplexity / AI Overviews cite you for?"),
    textareaField("sourceAssets", "Source Assets", false, "Docs, posts, research, data, or quotes the agent should use."),
    textField("competitors", "Known Competitors", false, "comma-separated"),
  ],
  "schema-markup": [
    urlField("pageUrl", "Page URL", true, "https://example.com/pricing"),
    selectField("pageType", "Page Type", true, ["Homepage", "Product", "Pricing", "Blog post", "FAQ", "Local business", "Other"]),
    textareaField("existingSchema", "Existing Schema", false, "Paste current JSON-LD or note 'none'."),
    textField("desiredRichResult", "Desired Rich Result", false, "FAQ, review stars, product, software app, breadcrumbs"),
  ],
  "programmatic-seo": [
    textField("seedKeyword", "Seed Keyword", true, "best CRM for"),
    textareaField("pageTemplate", "Page Template Idea", true, "e.g. [software] alternatives for [industry]"),
    textareaField("dataSource", "Data Source", true, "CSV columns, database fields, or manual list."),
    textField("targetSegments", "Target Segments", false, "cities, industries, integrations, competitors"),
  ],
  "site-architecture": [
    urlField("siteUrl", "Site URL", true, "https://example.com"),
    textareaField("primaryGoal", "Primary Goal", true, "Rank for product-led SEO terms, improve navigation, support launch, etc."),
    textareaField("existingPages", "Important Existing Pages", false, "Paste URLs or page names."),
    textField("prioritySections", "Priority Sections", false, "features, integrations, comparisons, resources"),
  ],
  "aso-audit": [
    urlField("appStoreUrl", "App Store / Play Store URL", true, "https://apps.apple.com/..."),
    selectField("platform", "Platform", true, ["iOS App Store", "Google Play", "Both"]),
    textField("targetKeywords", "Target Keywords", false, "comma-separated"),
    textareaField("competitorApps", "Competitor Apps", false, "Names or store URLs."),
  ],
  "directory-submissions": [
    urlField("productUrl", "Product URL", true, "https://example.com"),
    textField("productCategory", "Product Category", true, "AI marketing agent, CRM, analytics, etc."),
    textareaField("targetDirectories", "Target Directories", false, "Product Hunt, BetaList, Futurepedia, G2, etc."),
    textareaField("positioning", "Short Positioning", true, "One sentence explaining who it is for and why it matters."),
  ],
  copywriting: [
    selectField("pageType", "Copy Type", true, ["Homepage", "Landing page", "Pricing page", "Feature page", "About page", "Product page", "Other"]),
    textField("productName", "Product Name", true, "Acme Analytics"),
    textField("targetAudience", "Target Audience", true, "B2B SaaS founders"),
    textareaField("offer", "Offer / Value Proposition", true, "What are we selling and why should people care?"),
    textField("desiredAction", "Desired Action", true, "Book a demo, start free trial, join waitlist"),
    textField("brandTone", "Brand Tone", false, "clear, confident, warm"),
  ],
  "copy-editing": [
    textareaField("existingCopy", "Existing Copy", true, "Paste the copy to improve."),
    textField("targetAudience", "Target Audience", true, "Who is this for?"),
    textareaField("copyProblem", "What Feels Wrong", false, "Too vague, too long, weak CTA, outdated, etc."),
    textField("brandTone", "Brand Tone", false, "professional, punchy, friendly"),
  ],
  "content-strategy": [
    urlField("productUrl", "Product URL", false, "https://example.com"),
    textField("targetAudience", "Target Audience", true, "Who should the content attract?"),
    textareaField("businessGoal", "Business Goal", true, "Pipeline, signups, authority, launch support, retention, etc."),
    textareaField("topicSeeds", "Topic Seeds", false, "Keywords, customer questions, competitor topics."),
    textField("cadence", "Publishing Cadence", false, "2 posts/week, monthly report, etc."),
  ],
  "social-content": [
    selectField("platform", "Platform", true, ["LinkedIn", "X / Twitter", "Instagram", "TikTok", "Facebook", "Multi-platform"]),
    textField("targetAudience", "Target Audience", true, "Founders, marketers, developers, etc."),
    textareaField("message", "Core Message", true, "What should the post/thread/video communicate?"),
    textareaField("sourceAsset", "Source Asset", false, "Blog post, launch note, transcript, product update."),
    textField("desiredAction", "Desired Action", false, "comment, click, signup, share"),
  ],
  image: [
    selectField("assetType", "Asset Type", true, ["Blog hero", "Social graphic", "Product mockup", "Profile banner", "Listing visual", "Other"]),
    textField("productName", "Product Name", true, "Acme Analytics"),
    textField("targetAudience", "Target Audience", false, "Who should this appeal to?"),
    textareaField("visualStyle", "Visual Style", true, "Clean SaaS dashboard, editorial, cinematic, playful, etc."),
    textField("copyText", "Text To Include", false, "Optional visible words."),
  ],
  video: [
    selectField("videoType", "Video Type", true, ["Explainer", "Product demo", "Launch video", "Ad", "Social short", "AI avatar"]),
    textField("targetAudience", "Target Audience", true, "Who is watching?"),
    textareaField("coreMessage", "Core Message", true, "What should viewers remember?"),
    textField("format", "Format", false, "30s vertical, 90s demo, 16:9 landing page video"),
    textareaField("sourceAssets", "Source Assets", false, "Script, URL, screenshots, product notes."),
  ],
  "lead-magnets": [
    textField("targetAudience", "Target Audience", true, "Who should download this?"),
    textareaField("painPoint", "Pain Point", true, "What problem should the lead magnet solve?"),
    selectField("format", "Format", true, ["Checklist", "Template", "Calculator", "Guide", "Swipe file", "Spreadsheet", "Other"]),
    textareaField("offer", "Follow-up Offer", false, "What paid product or next step should it lead to?"),
  ],
  "page-cro": [
    urlField("pageUrl", "Page URL", true, "https://example.com/pricing"),
    textField("conversionGoal", "Conversion Goal", true, "Book demo, start trial, buy plan, submit form"),
    textField("targetAudience", "Target Audience", true, "Who is the page for?"),
    textareaField("currentProblem", "Current Problem", false, "High bounce, weak CTA, low signup rate, etc."),
    textField("trafficSource", "Main Traffic Source", false, "SEO, ads, email, direct, social"),
  ],
  "signup-flow-cro": [
    urlField("signupUrl", "Signup URL", true, "https://example.com/signup"),
    textField("targetUser", "Target User", true, "Who is signing up?"),
    textareaField("currentSteps", "Current Steps", false, "List screens, fields, required actions."),
    textField("dropoffPoint", "Drop-off Point", false, "Where users abandon."),
    textField("activationGoal", "Activation Goal", true, "Create project, connect account, invite teammate"),
  ],
  "onboarding-cro": [
    textField("productType", "Product Type", true, "B2B SaaS analytics tool"),
    textField("newUserGoal", "New User Goal", true, "What should a new user accomplish first?"),
    textareaField("onboardingSteps", "Current Onboarding Steps", false, "List the flow or paste notes."),
    textField("activationMetric", "Activation Metric", false, "e.g. connected data source, created first report"),
  ],
  "form-cro": [
    urlField("formUrl", "Form URL", true, "https://example.com/demo"),
    textField("formPurpose", "Form Purpose", true, "Demo request, contact, application, survey"),
    textareaField("currentFields", "Current Fields", false, "Name, email, company size, phone, etc."),
    textField("targetAudience", "Target Audience", false, "Who fills this out?"),
    textareaField("conversionIssue", "Conversion Issue", false, "Too many fields, low intent, weak offer, etc."),
  ],
  "popup-cro": [
    urlField("pageUrl", "Page URL", true, "https://example.com/blog/post"),
    textField("popupGoal", "Popup Goal", true, "Collect email, announce offer, route users, reduce exit"),
    textField("trigger", "Trigger", false, "Exit intent, 50% scroll, time delay, pricing page visit"),
    textareaField("offer", "Offer", true, "What should the popup promise?"),
  ],
  "paywall-upgrade-cro": [
    textField("productArea", "Product Area", true, "Reports, exports, AI credits, seats"),
    textareaField("freeLimit", "Free Limit / Gate", true, "What does the user hit before upgrading?"),
    textareaField("paidValue", "Paid Value", true, "What does upgrading unlock?"),
    textField("audienceSegment", "Audience Segment", false, "Free users, trial users, power users"),
  ],
  "ab-test-setup": [
    urlField("pageUrl", "Page / Flow URL", false, "https://example.com/pricing"),
    textareaField("hypothesis", "Hypothesis", true, "Changing X will improve Y because Z."),
    textField("primaryMetric", "Primary Metric", true, "Signup conversion, demo request rate, activation"),
    textareaField("variants", "Variant Ideas", false, "What versions should be tested?"),
    numberField("weeklyTraffic", "Estimated Weekly Traffic", false, "5000"),
  ],
  "paid-ads": [
    selectField("platform", "Platform", true, ["Google Ads", "Meta Ads", "LinkedIn Ads", "X Ads", "TikTok Ads", "Multi-platform"]),
    textField("objective", "Campaign Objective", true, "Leads, trials, demos, purchases, awareness"),
    textareaField("targetAudience", "Target Audience", true, "Job titles, industries, pain points, exclusions."),
    textareaField("offer", "Offer", true, "What are the ads promoting?"),
    textField("budget", "Budget", false, "$100/day, $3k/month, etc."),
  ],
  "ad-creative": [
    selectField("platform", "Platform", true, ["Google Search", "Meta", "LinkedIn", "X", "TikTok", "Multi-platform"]),
    textField("targetAudience", "Target Audience", true, "Who should the ad speak to?"),
    textareaField("offer", "Offer", true, "What should the ad sell or promote?"),
    textareaField("proofPoints", "Proof Points", false, "Results, testimonials, stats, logos."),
    textField("angle", "Creative Angle", false, "pain point, aspiration, comparison, urgency"),
  ],
  "cold-email": [
    textField("icp", "Ideal Customer Profile", true, "VP Marketing at B2B SaaS, 50-500 employees"),
    textareaField("offer", "Offer", true, "What are you asking them to consider?"),
    textField("senderRole", "Sender Role", true, "Founder, AE, consultant, head of growth"),
    textareaField("proofPoints", "Proof / Credibility", false, "Customers, metrics, case study, insight."),
    textareaField("likelyObjection", "Likely Objection", false, "Too busy, already has tool, no budget."),
    textField("callToAction", "Call To Action", true, "15-minute call, reply with interest, see teardown"),
  ],
  "email-sequence": [
    selectField("sequenceType", "Sequence Type", true, ["Welcome", "Onboarding", "Nurture", "Re-engagement", "Trial expiration", "Win-back", "Other"]),
    textField("audience", "Audience", true, "New trial users, inactive leads, customers, etc."),
    textField("trigger", "Trigger", true, "Signup, demo request, abandoned setup, churn risk"),
    textareaField("offer", "Offer / Message", true, "What should this sequence move people toward?"),
    numberField("numberOfEmails", "Number Of Emails", false, "5"),
  ],
  "customer-research": [
    textareaField("researchSource", "Research Source", true, "Interview notes, reviews, survey data, support tickets, Reddit links."),
    textField("audienceSegment", "Audience Segment", false, "SMB founders, enterprise admins, agencies"),
    textareaField("questions", "Research Questions", true, "What do you want to learn?"),
    textField("outputGoal", "Output Goal", false, "Personas, JTBD, messaging, objections, roadmap signals"),
  ],
  "competitor-profiling": [
    textareaField("competitorUrls", "Competitor URLs", true, "One URL per line."),
    urlField("yourProductUrl", "Your Product URL", false, "https://example.com"),
    textField("comparisonAngle", "Comparison Angle", false, "pricing, positioning, features, SEO, ICP"),
    textField("targetBuyer", "Target Buyer", false, "Who are we comparing for?"),
  ],
  "competitor-alternatives": [
    textField("competitorName", "Competitor Name", true, "HubSpot"),
    textField("yourProductName", "Your Product Name", true, "Acme CRM"),
    textField("targetKeyword", "Target Keyword", false, "HubSpot alternatives"),
    textareaField("differentiators", "Your Differentiators", true, "What makes you different or better for this buyer?"),
    textareaField("proofPoints", "Proof Points", false, "Reviews, results, customer examples."),
  ],
  "marketing-psychology": [
    textField("audience", "Audience", true, "Who are we trying to influence?"),
    textField("behaviorToChange", "Behavior To Change", true, "Start trial, complete onboarding, upgrade, refer"),
    textField("decisionStage", "Decision Stage", false, "Unaware, problem-aware, solution-aware, ready to buy"),
    textareaField("offer", "Offer / Experience", true, "What page, email, or flow should be improved?"),
  ],
  "launch-strategy": [
    textField("productFeature", "Product / Feature", true, "What are you launching?"),
    textField("launchDate", "Launch Date", false, "YYYY-MM-DD or rough timing"),
    textField("audience", "Audience", true, "Who is this launch for?"),
    textareaField("channels", "Launch Channels", false, "Product Hunt, email, LinkedIn, partners, ads."),
    textareaField("assets", "Available Assets", false, "Demo video, screenshots, waitlist, case study."),
  ],
  "marketing-ideas": [
    textField("productName", "Product Name", true, "Acme Analytics"),
    textField("audience", "Audience", true, "Who are we trying to reach?"),
    textField("growthGoal", "Growth Goal", true, "More trials, demos, traffic, retention, awareness"),
    textareaField("constraints", "Constraints", false, "No paid ads, tiny team, B2B only, etc."),
    textField("currentChannels", "Current Channels", false, "SEO, LinkedIn, outbound, partners"),
  ],
  "pricing-strategy": [
    textareaField("currentPricing", "Current Pricing", true, "Plans, prices, limits, packaging."),
    textField("valueMetric", "Value Metric", false, "Seats, usage, contacts, credits, revenue"),
    textareaField("buyerSegments", "Buyer Segments", true, "SMB, mid-market, enterprise, agencies, etc."),
    textField("competitors", "Competitors", false, "comma-separated"),
    textareaField("pricingWorries", "Pricing Worries", false, "Too cheap, too complex, low upgrades, sales objections."),
  ],
  "product-marketing-context": [
    textField("productName", "Product Name", true, "Acme Analytics"),
    urlField("websiteUrl", "Website URL", false, "https://example.com"),
    textField("audience", "Ideal Customer", true, "Who is it for?"),
    textareaField("positioning", "Positioning", true, "What does it do and why now?"),
    textField("competitors", "Competitors", false, "comma-separated"),
  ],
  "free-tool-strategy": [
    textField("audience", "Audience", true, "Who would use this free tool?"),
    textareaField("problem", "Problem To Solve", true, "What useful job should the tool do?"),
    textField("toolIdea", "Tool Idea", false, "ROI calculator, audit grader, generator, checker"),
    textField("acquisitionGoal", "Acquisition Goal", true, "Backlinks, signups, demos, brand awareness"),
  ],
  "co-marketing": [
    textField("productName", "Product Name", true, "Acme Analytics"),
    textField("idealPartner", "Ideal Partner", true, "Tools, agencies, newsletters, communities"),
    textField("sharedAudience", "Shared Audience", true, "Who should both sides reach?"),
    textareaField("offer", "Joint Offer", false, "Webinar, guide, integration, bundle, benchmark report."),
  ],
  "community-marketing": [
    textField("audience", "Community Audience", true, "Who should gather here?"),
    selectField("communityType", "Community Type", true, ["Discord", "Slack", "Forum", "Subreddit", "LinkedIn group", "In-app", "Other"]),
    textField("goal", "Community Goal", true, "Support, advocacy, retention, content, pipeline"),
    textareaField("currentPresence", "Current Presence", false, "Existing channels, member count, engagement."),
  ],
  "sales-enablement": [
    selectField("salesMotion", "Sales Motion", true, ["Self-serve", "PLG + sales assist", "Sales-led", "Enterprise", "Channel"]),
    textField("buyerPersona", "Buyer Persona", true, "VP Marketing, founder, RevOps leader"),
    textField("dealStage", "Deal Stage", false, "Discovery, demo, proposal, procurement"),
    textareaField("objections", "Common Objections", true, "Too expensive, already using X, security, timing."),
    textField("collateralNeeded", "Collateral Needed", true, "Deck, one-pager, battlecard, demo script"),
  ],
  "churn-prevention": [
    textField("productType", "Product Type", true, "Subscription SaaS, marketplace, app, etc."),
    textField("churnSignal", "Churn Signal", true, "Cancellation, low usage, failed payment, downgrade"),
    textareaField("cancellationReasons", "Known Reasons", false, "Too expensive, not enough value, missing feature."),
    textareaField("saveOffer", "Possible Save Offer", false, "Pause, discount, concierge setup, plan switch."),
  ],
  "referral-program": [
    textField("productName", "Product Name", true, "Acme Analytics"),
    textField("customerSegment", "Customer Segment", true, "Who would refer?"),
    textField("incentive", "Incentive", false, "$ credit, free month, affiliate payout, swag"),
    textField("referralMoment", "Referral Moment", true, "After success, invite teammate, publish result, renewal"),
  ],
  revops: [
    textField("crmSystem", "CRM / Stack", false, "HubSpot, Salesforce, Pipedrive, spreadsheets"),
    textareaField("lifecycleProblem", "Lifecycle Problem", true, "Leads not routed, bad scoring, MQL confusion, stale pipeline."),
    textareaField("currentStages", "Current Stages", false, "Lead, MQL, SQL, Opportunity, Customer, etc."),
    textareaField("scoringSignals", "Scoring Signals", false, "Firmographics, behavior, source, intent."),
  ],
  "analytics-tracking": [
    urlField("websiteUrl", "Website URL", true, "https://example.com"),
    textField("analyticsStack", "Analytics Stack", false, "GA4, GTM, Segment, Mixpanel, PostHog"),
    textareaField("keyConversions", "Key Conversions", true, "Signup, demo request, checkout, activation, upgrade."),
    textareaField("eventsToTrack", "Events To Track", false, "Button clicks, form submits, onboarding steps."),
    textareaField("currentIssue", "Current Issue", false, "Missing events, bad attribution, duplicate tags, no UTMs."),
  ],
};

// Tools every skill gets unless its catalog entry says otherwise. Keep this
// list narrow — anything that writes belongs on a per-skill allowlist.
export const DEFAULT_TOOLS: string[] = [
  "web_search",
  "read_url",
  "write_draft",
  "finish",
];

// Helper: most stubs share the same draft-only shape. They can now have
// skill-specific briefs without pretending they are fully executable.
function draftOnlyStub(
  id: string,
  displayName: string,
  category: SkillCatalogEntry["category"],
  tagline: string,
  description: string,
): SkillCatalogEntry {
  return {
    id,
    displayName,
    category,
    tagline,
    description,
    maturity: "draft-only",
    briefFields: skillBriefFields[id] ?? [],
    outputs: ["draft", "recommendationList"],
    allowedTools: [],
    requiredConnectors: [],
    optionalConnectors: [],
    defaultApprovalBehavior: "drafts-only",
    budgetSensitive: false,
    testPrompt: `Run the ${displayName} workflow for my product.`,
    expectedArtifacts: ["draft saved to Drafts"],
    comingSoonNote: "Brief form, structured output, and dedicated tools coming in v2.",
  };
}

export const skillCatalog: SkillCatalogEntry[] = [
  // ============================================================
  // SEO — the reference workflow. Fully filled in.
  // ============================================================
  {
    id: "seo-audit",
    displayName: "SEO Audit",
    category: "seo",
    tagline: "Crawl + audit a URL, save findings, propose PR fixes",
    description:
      "Crawls a target URL, runs technical and on-page SEO checks, writes a structured audit report, and (when a GitHub repo is connected) proposes a pull request with visible website improvements.",
    maturity: "executable",
    briefFields: [
      {
        key: "siteUrl",
        label: "Site URL",
        type: "url",
        required: true,
        placeholder: "https://example.com",
        helpText: "The page or root URL to audit.",
      },
      {
        key: "siteType",
        label: "Site Type",
        type: "select",
        required: false,
        options: ["SaaS", "E-commerce", "Blog", "Marketing site", "Other"],
      },
      {
        key: "primaryGoal",
        label: "Primary SEO Goal",
        type: "textarea",
        required: false,
        placeholder:
          "e.g. rank for 'AI marketing agent', drive demo signups",
        helpText: "What success looks like for this site's SEO.",
      },
      {
        key: "priorityKeywords",
        label: "Priority Keywords",
        type: "text",
        required: false,
        placeholder: "comma-separated",
      },
      {
        key: "knownIssues",
        label: "Known Issues",
        type: "textarea",
        required: false,
        helpText:
          "Anything you already suspect — slow pages, missing meta, recent migration, etc.",
      },
    ],
    outputs: ["audit", "recommendationList", "approvalRequest"],
    allowedTools: [
      "crawl_site",
      "audit_seo",
      "scan_repo_for_alt_text_gaps",
      "add_alt_text",
      "web_search",
      "read_url",
      "write_draft",
      "finish",
    ],
    requiredConnectors: ["site"],
    optionalConnectors: ["github"],
    defaultApprovalBehavior: "red-default",
    budgetSensitive: false,
    testPrompt:
      "Run an SEO audit on my primary workspace site. Use the connected GitHub repo from Integrations. Only create a GitHub PR if the audit finds useful improvements.",
    expectedArtifacts: [
      "audit report in SEO Reports",
      "at least one entry in Proposed Actions when fixes are warranted",
    ],
  },

  // ============================================================
  // The other 40 — honest stubs, draft-only.
  // Step 4 matures these one at a time (outputs, tools, autonomy).
  // ============================================================

  // --- seo bucket ---
  draftOnlyStub(
    "ai-seo",
    "AI Search Optimization",
    "seo",
    "Optimize for LLM answer engines",
    "Improve how your content is cited by AI search engines (ChatGPT, Perplexity, Google AI Overviews, Gemini).",
  ),
  draftOnlyStub(
    "schema-markup",
    "Schema Markup",
    "seo",
    "Add structured data + JSON-LD",
    "Plan and propose schema.org structured data so pages can earn rich results in Google.",
  ),
  draftOnlyStub(
    "programmatic-seo",
    "Programmatic SEO",
    "seo",
    "SEO pages at scale from templates + data",
    "Plan template-based pages to capture long-tail queries (location pages, comparison pages, integration pages).",
  ),
  draftOnlyStub(
    "site-architecture",
    "Site Architecture",
    "seo",
    "Plan site hierarchy + internal linking",
    "Map page hierarchy, URL structure, and internal linking for a marketing site.",
  ),
  draftOnlyStub(
    "aso-audit",
    "App Store Optimization",
    "seo",
    "Audit App Store / Play Store listings",
    "Review an App Store or Play Store listing and recommend visibility and conversion fixes.",
  ),
  draftOnlyStub(
    "directory-submissions",
    "Directory Submissions",
    "seo",
    "Submit to startup + SaaS + AI directories",
    "Plan the directory layer of a launch — backlinks, discovery, and tracker.",
  ),

  // --- content bucket ---
  draftOnlyStub(
    "copywriting",
    "Copywriting",
    "content",
    "Draft homepage / landing / pricing copy",
    "Write or rewrite marketing copy for any page — homepage, landing, pricing, feature, about.",
  ),
  draftOnlyStub(
    "copy-editing",
    "Copy Editing",
    "content",
    "Edit, polish, and refresh existing copy",
    "Improve existing marketing copy or refresh outdated content rather than rewriting from scratch.",
  ),
  draftOnlyStub(
    "content-strategy",
    "Content Strategy",
    "content",
    "Plan blog / content calendar + topic clusters",
    "Decide what content to produce, how to cluster topics, and how to sequence the editorial calendar.",
  ),
  draftOnlyStub(
    "social-content",
    "Social Content",
    "content",
    "LinkedIn / X / Instagram / TikTok posts + scripts",
    "Create social media content and short-form video scripts across platforms.",
  ),
  draftOnlyStub(
    "image",
    "Marketing Imagery",
    "content",
    "Generate hero / social / OG / banner images",
    "Plan and generate general-purpose marketing imagery — heroes, social graphics, OG images, banners.",
  ),
  draftOnlyStub(
    "video",
    "Marketing Video",
    "content",
    "Plan AI-generated + programmatic video",
    "Plan AI video production using Remotion, HeyGen, Synthesia, Veo, Runway, Kling, Pika.",
  ),
  draftOnlyStub(
    "lead-magnets",
    "Lead Magnets",
    "content",
    "Plan gated content for email capture",
    "Plan and outline lead magnets — ebooks, checklists, templates, content upgrades.",
  ),

  // --- cro bucket ---
  draftOnlyStub(
    "page-cro",
    "Page CRO",
    "cro",
    "Improve conversions on a marketing page",
    "Diagnose and propose fixes for any underconverting marketing page.",
  ),
  draftOnlyStub(
    "signup-flow-cro",
    "Signup Flow CRO",
    "cro",
    "Optimize signup / registration / trial flows",
    "Reduce friction in signup, registration, account creation, or trial activation.",
  ),
  draftOnlyStub(
    "onboarding-cro",
    "Onboarding CRO",
    "cro",
    "Improve activation + first-run experience",
    "Increase activation rate, time-to-value, and first-session completion.",
  ),
  draftOnlyStub(
    "form-cro",
    "Form CRO",
    "cro",
    "Optimize lead capture / contact / demo forms",
    "Improve completion rate on lead, contact, demo, application, or survey forms.",
  ),
  draftOnlyStub(
    "popup-cro",
    "Popup CRO",
    "cro",
    "Optimize popups, modals, banners, slide-ins",
    "Plan or fix popups, modals, exit-intent overlays, and sticky bars.",
  ),
  draftOnlyStub(
    "paywall-upgrade-cro",
    "Paywall + Upgrade CRO",
    "cro",
    "Improve in-app upgrade + paywall conversion",
    "Optimize in-app paywalls, upgrade screens, upsell modals, and feature gates.",
  ),
  draftOnlyStub(
    "ab-test-setup",
    "A/B Test Setup",
    "cro",
    "Design and plan A/B tests + experiments",
    "Plan A/B tests, multivariate tests, and a growth experimentation program.",
  ),

  // --- paid bucket ---
  draftOnlyStub(
    "paid-ads",
    "Paid Ads",
    "paid",
    "Campaign strategy + targeting + optimization",
    "Plan and optimize paid campaigns on Google / Meta / LinkedIn / X — strategy, targeting, bidding.",
  ),
  draftOnlyStub(
    "ad-creative",
    "Ad Creative",
    "paid",
    "Generate ad headline + copy variants at scale",
    "Generate and iterate ad creative — headlines, descriptions, primary text — for paid platforms.",
  ),

  // --- email bucket ---
  draftOnlyStub(
    "cold-email",
    "Cold Email",
    "email",
    "B2B cold outreach + follow-up sequences",
    "Write cold outreach emails and multi-touch follow-up sequences that get replies.",
  ),
  draftOnlyStub(
    "email-sequence",
    "Email Sequence",
    "email",
    "Drip / nurture / onboarding / lifecycle emails",
    "Plan and write multi-email automated flows — welcome, nurture, re-engagement, lifecycle.",
  ),

  // --- research bucket ---
  draftOnlyStub(
    "customer-research",
    "Customer Research",
    "research",
    "Analyze interviews, reviews, transcripts, VOC",
    "Conduct or synthesize customer research — interviews, support tickets, reviews, JTBD, personas.",
  ),
  {
    id: "competitor-profiling",
    displayName: "Competitor Profiling",
    category: "research",
    tagline: "Profile competitors from URLs",
    description:
      "Research competitors and produce structured competitor profiles from a list of URLs.",
    maturity: "guided",
    briefFields: skillBriefFields["competitor-profiling"],
    outputs: ["competitorProfile", "recommendationList"],
    // crawl_competitor returns structured facts (hero, CTAs, pricing signals,
    // social proof) tuned for competitor research. read_url stays as a fallback
    // for non-competitor pages the orchestrator may want to skim (comparison
    // articles, review sites). web_search was removed — DuckDuckGo instant-
    // answer returns near-nothing for competitor queries and just wastes a
    // tool slot; a real search provider will be added as a separate step.
    allowedTools: ["crawl_competitor", "read_url", "write_draft", "finish"],
    requiredConnectors: [],
    optionalConnectors: [],
    defaultApprovalBehavior: "drafts-only",
    budgetSensitive: false,
    testPrompt:
      "Profile these competitors and summarize their positioning, strengths, weaknesses, and opportunities for our product.",
    expectedArtifacts: [
      "structured competitor profile",
      "recommendation list",
      "draft saved to Drafts",
    ],
    comingSoonNote:
      "Guided research output is available; autonomous monitoring comes later.",
  },
  draftOnlyStub(
    "competitor-alternatives",
    "Competitor Comparison Pages",
    "research",
    "Build vs / alternative SEO + sales pages",
    "Create competitor comparison and alternative pages for SEO and sales enablement.",
  ),
  draftOnlyStub(
    "marketing-psychology",
    "Marketing Psychology",
    "research",
    "Apply behavioral science + mental models",
    "Apply psychological principles and behavioral science to marketing decisions.",
  ),

  // --- strategy bucket ---
  draftOnlyStub(
    "launch-strategy",
    "Launch Strategy",
    "strategy",
    "Plan a product / feature launch end-to-end",
    "Plan a product launch, feature announcement, or release — Product Hunt, GTM, checklist.",
  ),
  draftOnlyStub(
    "marketing-ideas",
    "Marketing Brainstorm",
    "strategy",
    "Channel + tactic ideas when you're stuck",
    "Generate marketing ideas, growth strategies, and channel tactics for a SaaS product.",
  ),
  draftOnlyStub(
    "pricing-strategy",
    "Pricing Strategy",
    "strategy",
    "Tiers / packaging / monetization decisions",
    "Help with pricing, packaging, freemium, free trials, and monetization decisions.",
  ),
  draftOnlyStub(
    "product-marketing-context",
    "Product Marketing Context",
    "strategy",
    "Create the product context other skills read",
    "Set up the product marketing context document that other skills reference for positioning.",
  ),
  draftOnlyStub(
    "free-tool-strategy",
    "Free Tool Strategy",
    "strategy",
    "Plan engineering-as-marketing free tools",
    "Plan and evaluate free interactive tools for lead generation, SEO, and brand awareness.",
  ),
  draftOnlyStub(
    "co-marketing",
    "Co-Marketing",
    "strategy",
    "Find partners + plan joint campaigns",
    "Find co-marketing partners and plan joint campaigns, cross-promotion, and integrations.",
  ),
  draftOnlyStub(
    "community-marketing",
    "Community Marketing",
    "strategy",
    "Build + grow Discord / Slack / forum communities",
    "Plan community strategy, community-led growth, ambassador programs, and engagement.",
  ),
  draftOnlyStub(
    "sales-enablement",
    "Sales Enablement",
    "strategy",
    "Decks, one-pagers, objection handling, scripts",
    "Create sales collateral — pitch decks, one-pagers, objection handling, demo scripts.",
  ),

  // --- lifecycle bucket ---
  draftOnlyStub(
    "churn-prevention",
    "Churn Prevention",
    "lifecycle",
    "Cancel flows + save offers + dunning + win-back",
    "Reduce churn — cancellation flows, save offers, failed payment recovery, retention strategies.",
  ),
  draftOnlyStub(
    "referral-program",
    "Referral Program",
    "lifecycle",
    "Plan referral / affiliate / word-of-mouth loops",
    "Plan and optimize referral programs, affiliate programs, and word-of-mouth virality.",
  ),
  draftOnlyStub(
    "revops",
    "RevOps",
    "lifecycle",
    "Lead scoring + routing + MQL/SQL handoff",
    "Lead lifecycle, scoring, routing, MQL→SQL handoff, CRM hygiene, and pipeline systems.",
  ),
  draftOnlyStub(
    "analytics-tracking",
    "Analytics + Tracking",
    "lifecycle",
    "GA4, GTM, conversion + event tracking setup",
    "Set up, audit, or improve analytics — GA4, GTM, conversion tracking, event taxonomy, UTM.",
  ),
];

// ------------------------------------------------------------
// Lookups — the only API the rest of the app should use.
// ------------------------------------------------------------

const byId = new Map<string, SkillCatalogEntry>(
  skillCatalog.map((s) => [s.id, s]),
);

export function getSkill(skillId: string): SkillCatalogEntry | undefined {
  return byId.get(skillId);
}

export function listSkills(): SkillCatalogEntry[] {
  return skillCatalog;
}

// Tool allowlist resolution — empty `allowedTools` on a catalog entry means
// "fall back to DEFAULT_TOOLS". This preserves the old manifest.ts behavior
// for the 40 stub skills until each one is matured in Step 4.
export function allowedToolsFor(skillId: string): string[] {
  const entry = byId.get(skillId);
  if (!entry) return DEFAULT_TOOLS;
  if (entry.allowedTools.length === 0) return DEFAULT_TOOLS;
  return entry.allowedTools;
}
