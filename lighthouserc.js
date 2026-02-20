/**
 * Lighthouse CI config for Vercel Preview + Deployment Protection bypass.
 *
 * Usage (run twice):
 *   LH_PRESET=mobile  lhci autorun
 *   LH_PRESET=desktop lhci autorun
 *
 * Workflow should set:
 *   - VERCEL_AUTOMATION_BYPASS_SECRET
 *   - LHCI_PREVIEW_URL (or pass urls via action input)
 */

const preset = (process.env.LH_PRESET || "mobile").toLowerCase();
const isDesktop = preset === "desktop";

// Targets from Plasma website spec:
// - LCP < 1s, CLS < 0.1, TTFB < 300ms
// - PageSpeed/Lighthouse: Mobile > 90, Desktop > 95
// - Lighthouse SEO > 95
// - "3G within 8 seconds" (Namibia test)

module.exports = {
  ci: {
    collect: {
      // Prefer passing URL(s) from the workflow.
      // If you want a fallback, set LHCI_PREVIEW_URL.
      url: process.env.LHCI_PREVIEW_URL
        ? [process.env.LHCI_PREVIEW_URL]
        : undefined,

      numberOfRuns: 3,

      settings: {
        ...(isDesktop ? { preset: "desktop" } : {}),
        formFactor: isDesktop ? "desktop" : "mobile",

        // More stable CI runs
        throttlingMethod: "devtools",
        chromeFlags: ["--no-sandbox", "--disable-dev-shm-usage"],

        // Bypass Vercel Deployment Protection (Standard Protection)
        extraHeaders: {
          "x-vercel-protection-bypass":
            process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          "x-vercel-set-bypass-cookie": "true",
        },
      },
    },

    upload: {
      // Keep reports private; workflow uploads as GH artifact and links in PR comment.
      target: "filesystem",
      outputDir: `./.lighthouseci/${preset}`,
    },

    assert: {
      preset: "lighthouse:recommended",
      assertions: {
        /**
         * CATEGORY GATES
         * Mobile >90 and Desktop >95 for PageSpeed/Lighthouse, SEO >95.
         */
        "categories:performance": [
          "error",
          { minScore: isDesktop ? 0.95 : 0.9 },
        ],
        "categories:seo": ["error", { minScore: 0.95 }],
        // Vercel preview deployments set X-Robots-Tag: noindex by design;
        // production does not, so this audit is a false positive in CI.
        "is-crawlable": "off",

        "categories:accessibility": ["warn", { minScore: 0.9 }],
        "categories:best-practices": ["warn", { minScore: 0.9 }],

        /**
         * METRIC / AUDIT GATES (lab equivalents)
         * LCP < 1s, CLS < 0.1, TTFB < 300ms
         */
        "largest-contentful-paint": ["error", { maxNumericValue: 1000 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        // TTFB proxy in Lighthouse is "server-response-time"
        "server-response-time": ["error", { maxNumericValue: 300 }],

        /**
         * FID isn't available in Lighthouse lab. Use TBT as the gate.
         * Spec says FID < 100ms.
         */
        "total-blocking-time": ["warn", { maxNumericValue: 200 }],

        /**
         * "Namibia test": legible/functional on 3G within 8s.
         * Closest lab metric gates are TTI and Speed Index.
         */
        interactive: ["warn", { maxNumericValue: 8000 }],
        "speed-index": ["warn", { maxNumericValue: 8000 }],
      },
    },
  },
};
