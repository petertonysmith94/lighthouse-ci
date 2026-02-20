// Plasma website QA thresholds — derived from Project Specification v1.3
// Update these if the spec changes.

export const THRESHOLDS = {
  performance: {
    lcp: 1000,         // < 1s  (milliseconds)
    fid: 100,          // < 100ms
    cls: 0.1,          // < 0.1
    ttfb: 300,         // < 300ms
    mobileScore: 90,   // PageSpeed Mobile > 90
    desktopScore: 95,  // PageSpeed Desktop > 95
  },
  seo: {
    lighthouseScore: 95, // Lighthouse SEO > 95
  },
  accessibility: {
    standard: 'wcag21aa', // WCAG 2.1 Level AA
  },
  throttledLoad: 8000,   // "Namibia Test" — functional on 3G < 8s
};

export const BREAKPOINTS = [
  { name: 'Desktop',  width: 1440, height: 900 },
  { name: 'Laptop',   width: 1024, height: 768 },
  { name: 'Tablet',   width: 768,  height: 1024 },
  { name: 'Mobile',   width: 375,  height: 812 },
];

export const BROWSERS = ['chromium', 'webkit', 'firefox'];

// Supported browsers per spec: Chrome, Safari, Firefox, Edge (latest 2 versions)
// Playwright engines: chromium (covers Chrome/Edge), webkit (covers Safari), firefox

// ── Lighthouse Configuration ────────────────────────────────
export const LIGHTHOUSE = {
  categories: ['performance', 'seo', 'accessibility', 'best-practices'],
  quickCategories: {
    mobile: ['performance', 'seo', 'accessibility'],
    desktop: ['performance', 'seo'],
  },
  chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'],
  strategies: {
    mobile: {
      formFactor: 'mobile',
      screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 3 },
      throttling: undefined, // Lighthouse default mobile throttling
    },
    desktop: {
      formFactor: 'desktop',
      screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1 },
      throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
    },
  },
  throttle3g: {
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 3 },
    throttling: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4 },
    categories: ['performance'],
  },
  metricKeys: {
    lcp: 'largestContentfulPaint',
    fid: 'maxPotentialFID',
    cls: 'cumulative-layout-shift', // audit ID, not metrics key
    ttfb: 'timeToFirstByte',
    interactive: 'interactive',
  },
  failedAuditThreshold: 0.5,   // Flag audits scoring below 50%
  display: {
    failedAuditLimit: 10,        // Max failed audits to show in standalone
    failedAuditLimitFull: 5,     // Max failed audits to show in full-audit
    quickIssueLimit: 3,          // Max issues shown in quick-check
  },
};

// ── Accessibility Configuration ─────────────────────────────
export const ACCESSIBILITY = {
  defaultTags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  impactOrder: { critical: 0, serious: 1, moderate: 2, minor: 3 },
  criticalSeverities: ['critical', 'serious'],
  settleTimeout: 2000, // ms to wait for lazy content / animations
  checklist: {
    contrast: {
      label: 'Colour contrast meets AA minimums (4.5:1 text, 3:1 large)',
      failLabel: 'Colour contrast',
      match: v => v.id === 'color-contrast',
    },
    aria: {
      label: 'Interactive elements have accessible names',
      failLabel: 'Accessible names',
      match: v => v.id.startsWith('aria-') || v.id.includes('label') || v.id.includes('name'),
    },
    focus: {
      label: 'No focus-related violations detected',
      failLabel: 'Focus',
      match: v => v.id.includes('focus') || v.id === 'tabindex',
    },
    colorOnly: {
      label: 'No colour-only content issues detected',
      failLabel: 'Colour-only content',
      match: v => v.id.includes('color') && v.id !== 'color-contrast',
    },
  },
  manualChecks: [
    'Keyboard navigation (Tab/Enter/Escape) requires manual testing',
    'Focus indicator visibility requires visual inspection',
  ],
  display: {
    violationNodeLimit: 3,   // Nodes shown per violation
    incompleteLimit: 5,      // Incomplete items shown
  },
};

// ── Breakpoint Test Configuration ───────────────────────────
export const BREAKPOINT_TEST = {
  devices: {
    Desktop: { deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    Laptop:  { deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    Tablet:  { deviceScaleFactor: 2, isMobile: true,  hasTouch: true },
    Mobile:  { deviceScaleFactor: 3, isMobile: true,  hasTouch: true },
  },
  overflowScanLimit: 5,      // Max overflowing elements to report
  overflowTolerance: 1,      // px tolerance for rounding
  settleTimeout: 2000,       // ms to wait for animations/lazy content
  navigationTimeout: 30000,  // ms
  manualChecks: [
    'Visual accuracy against Figma designs requires manual comparison',
    'Touch targets and safe areas (iOS) require manual testing',
  ],
};

// ── SEO Configuration ───────────────────────────────────────
export const SEO = {
  requiredOgTags: ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'],
  requiredTwitterTags: ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'],
  expectedJsonLdTypes: ['Organization', 'Product', 'FAQPage', 'BreadcrumbList'],
  semanticElements: ['main', 'nav', 'article', 'section', 'header', 'footer', 'aside'],
  minSemanticElements: 3,
  metaLengthLimits: {
    titleWarn: 70,
    descriptionWarn: 160,
  },
  ssr: {
    minContentLength: 5000,       // Raw HTML must exceed this to count as SSR
    metaSelector: 'meta name="description"',  // String to search in raw HTML
    timeout: 10000,
  },
  settleTimeout: 1000,
  display: {
    titleTruncate: 60,
    descriptionTruncate: 80,
    ogValueTruncate: 80,
    missingAltLimit: 5,
    jsonLdRawTruncate: 200,
    imgSrcTruncate: 100,
    imgClassTruncate: 50,
    headingTextTruncate: 60,
  },
  reminders: [
    'Sitemap and robots.txt should be checked at site level, not per page',
    'Lighthouse SEO score checked separately via: npm run lighthouse',
  ],
};

// ── Link Checker Configuration ──────────────────────────────
export const LINK_CHECKER = {
  maxPages: 50,
  navigationTimeout: 15000,
  settleTimeout: 1000,
  display: {
    brokenLinkLimit: 20,
    externalLinkLimit: 15,
    urlTruncate: 80,
  },
};

// ── Redirects Configuration ─────────────────────────────────
export const REDIRECTS = {
  navigationTimeout: 15000,
  custom404: {
    minContentLength: 1000,
    navDetectors: ['<nav', 'nav'],
    homeLinkDetectors: ['home', 'Home', '/'],
  },
  display: {
    externalLinkLimit: 10,
    linkTextTruncate: 50,
  },
};

// ── PageSpeed Diagnostics Configuration ─────────────────
export const PAGESPEED = {
  thresholds: {
    lcp: 1000,                // ms
    cls: 0.1,                 // unitless
    fcp: 1800,                // ms
    tbt: 200,                 // ms (total blocking time)
    renderBlockingCount: 3,   // max render-blocking resources
    renderBlockingTime: 500,  // ms total blocking time
    longTaskCount: 3,         // max long tasks during load
    longestTask: 200,         // ms
    unusedJs: 20,             // % of unused JS bytes
    totalPageWeight: 3000,    // KB
    criticalChainDepth: 4,    // max levels
  },
  capture: {
    settleTimeout: 3000,
    navigationTimeout: 30000,
    longTaskThreshold: 50,          // ms — tasks above this are "long"
    resourceTimingBufferSize: 250,
  },
  strategies: {
    mobile: {
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
    desktop: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  psi: {
    apiBase: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    timeout: 60000,
  },
  categories: {
    coreWebVitals:      { label: 'Core Web Vitals',       description: 'LCP, CLS, FCP timings' },
    renderBlocking:     { label: 'Render-Blocking',        description: 'Resources delaying first paint' },
    mainThread:         { label: 'Main Thread',            description: 'Long tasks and total blocking time' },
    layoutStability:    { label: 'Layout Stability',       description: 'Cumulative layout shift sources' },
    resourceEfficiency: { label: 'Resource Efficiency',    description: 'Page weight and unused code' },
    criticalPath:       { label: 'Critical Path',          description: 'Request chain depth and waterfall' },
  },
  display: {
    renderBlockingLimit: 10,
    longTaskLimit: 10,
    shiftSourceLimit: 5,
    unusedBundleLimit: 10,
    resourceLimit: 15,
    renderBlockingLimitFull: 5,
    longTaskLimitFull: 5,
    shiftSourceLimitFull: 3,
    unusedBundleLimitFull: 5,
    urlTruncate: 80,
  },
  manualChecks: [
    'Verify images are served in modern formats (WebP/AVIF) and appropriately sized',
    'Review third-party scripts for necessity and loading strategy (defer/async)',
  ],
};

// ── Sitemap Configuration ─────────────────────────────────
export const SITEMAP = {
  defaultPath: '/sitemap.xml',
  maxPages: 100,
  maxIndexDepth: 2,
  fetchTimeout: 15000,
  fallbackCrawlMaxPages: 30,
};

// ── Site Audit Configuration ──────────────────────────────
export const SITE_AUDIT = {
  perPageAudits: ['accessibility', 'seo'],
  sampledAudits: ['lighthouse', 'pagespeed', 'breakpoints'],
  siteWideAudits: ['redirects', 'links'],
  heavyAuditSampleSize: 3,
  concurrency: 1,
  pageTimeout: 120000,
  ci: {
    commentMaxLength: 60000,
    summaryMaxPages: 10,
    issueDetailLimit: 5,
  },
};
