# Plasma QA Tools

Standalone audit scripts for reviewing Callstack PRs against the [Plasma Website PR Review Checklist](./docs/checklist.md). Each script runs directly via Node.js — no MCP servers, no persistent processes. Optionally pipes results through Claude for analysis.

Derived from **Project Specification v1.3** (Feb 11, 2026).

---

## Setup

### Prerequisites

- **Node.js** ≥ 20
- **Google Chrome** (for Lighthouse)
- A **Vercel preview URL** or production URL to test

### Install

```bash
git clone <this-repo>
cd plasma-qa-tools
npm install

# Install Playwright browsers (Chromium, WebKit, Firefox)
npx playwright install
```

### Environment Variables (optional)

```bash
# Set once so you don't need --password on every command
export VERCEL_PREVIEW_PASSWORD="your-vercel-preview-password"

# For Claude-powered report analysis (optional)
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Commands

### Every PR: Quick Check (< 2 min)

Fast combined check — Lighthouse scores (mobile + desktop), axe-core summary, basic SEO meta tags.

```bash
npm run quick-check -- https://your-preview.vercel.app

# With Vercel password protection
npm run quick-check -- https://your-preview.vercel.app --password mypass
```

**Checklist coverage:** §3 (Performance scores), §4 (SEO score + meta tags), §7 (Critical a11y violations)

---

### Individual Scripts

#### Lighthouse Audit (§3 Performance + §4 SEO scores)

```bash
# Run both mobile + desktop
npm run lighthouse -- https://your-preview.vercel.app

# Mobile only
npm run lighthouse -- https://your-preview.vercel.app --strategy mobile

# Include 3G "Namibia Test"
npm run lighthouse -- https://your-preview.vercel.app --throttle-3g

# With Vercel auth
npm run lighthouse -- https://your-preview.vercel.app -p mypass
```

**Checks against spec thresholds:**
| Metric | Target |
|--------|--------|
| LCP | < 1s |
| FID | < 100ms |
| CLS | < 0.1 |
| TTFB | < 300ms |
| PageSpeed Mobile | > 90 |
| PageSpeed Desktop | > 95 |
| Lighthouse SEO | > 95 |
| 3G Load (Namibia Test) | < 8s |

---

#### Accessibility Audit (§7 WCAG 2.1 AA)

```bash
# Full audit
npm run accessibility -- https://your-preview.vercel.app

# Summary only (faster, just counts)
npm run accessibility -- https://your-preview.vercel.app --summary-only

# Filter to specific rules
npm run accessibility -- https://your-preview.vercel.app --tags wcag21aa

# Scope to a specific section
npm run accessibility -- https://your-preview.vercel.app --include "main"
```

**Checks:**
- Colour contrast (4.5:1 text, 3:1 large text/UI)
- Accessible names (aria-labels on interactive elements)
- Focus-related issues
- Colour-only content

**Note:** Keyboard navigation (Tab/Enter/Escape) and focus indicator visibility require manual testing.

---

#### Breakpoint Test (§2 Responsive & Cross-Browser)

```bash
# Default: Chromium + WebKit at all 4 breakpoints
npm run breakpoints -- https://your-preview.vercel.app

# All three browser engines
npm run breakpoints -- https://your-preview.vercel.app --browsers chromium,webkit,firefox

# Full-page screenshots
npm run breakpoints -- https://your-preview.vercel.app --full-page
```

**Checks:**
- Screenshots at 1440px (Desktop), 1024px (Laptop), 768px (Tablet), 375px (Mobile)
- Horizontal overflow detection at each breakpoint
- Images without explicit dimensions (CLS risk)

Screenshots saved to `./reports/screenshots/<timestamp>/`

**Browser engine mapping:**
| Spec Requirement | Playwright Engine |
|------------------|-------------------|
| Chrome + Edge | chromium |
| Safari + iOS Safari | webkit |
| Firefox | firefox |

---

#### SEO Audit (§4 Full SEO check)

```bash
# Full SEO audit
npm run seo -- https://your-preview.vercel.app

# Include SSR verification
npm run seo -- https://your-preview.vercel.app --check-ssr
```

**Checks:**
- `<title>` tag present and reasonable length
- `<meta name="description">` present
- Canonical URL
- Open Graph tags (title, description, image, url, type)
- Twitter Card tags (card, title, description, image)
- JSON-LD structured data (Organisation, Product, FAQ, BreadcrumbList)
- Semantic HTML5 elements (main, nav, section, footer, etc.)
- Heading hierarchy (single H1, no skipped levels)
- All images have alt text
- Server-side rendering verification (optional)

---

#### Redirect & Link Checker (§9 Routing)

```bash
# Check 404 page and internal links
npm run redirects -- https://your-preview.vercel.app --check-404 --check-links

# Validate redirect map (plasma.to → plasma.org)
npm run redirects -- https://plasma.org --redirects ./redirects.json

# Combined
npm run redirects -- https://plasma.org --redirects ./redirects.json --check-404 --check-links
```

**Redirect map format** (`redirects.json`):
```json
[
  { "from": "https://plasma.to/", "to": "https://plasma.org/" },
  { "from": "https://plasma.to/insights", "to": "https://plasma.org/blog" },
  { "from": "https://plasma.to/insights/some-article", "to": "https://plasma.org/blog/some-article" }
]
```

---

## Reports

All reports are saved as JSON to `./reports/` with timestamps:

```
reports/
├── lighthouse_2026-02-14T10-30-00.json
├── accessibility_2026-02-14T10-30-00.json
├── breakpoints_2026-02-14T10-30-00.json
├── seo_2026-02-14T10-30-00.json
├── quick-check_2026-02-14T10-30-00.json
└── screenshots/
    └── 2026-02-14T10-30-00/
        ├── chromium_Desktop_1440px.png
        ├── chromium_Laptop_1024px.png
        ├── chromium_Tablet_768px.png
        ├── chromium_Mobile_375px.png
        ├── webkit_Desktop_1440px.png
        └── ...
```

To skip saving: add `--no-save` to any command.

---

## Exit Codes

All scripts use consistent exit codes:

| Code | Meaning |
|------|---------|
| 0 | All checks passed (or only minor/non-blocking issues) |
| 1 | One or more checks failed |
| 2 | Script error (crash, timeout, auth failure) |

This makes the scripts usable in CI/CD if you want to gate PRs later.

---

## Checklist Coverage Map

| Checklist Section | Script | Automated? |
|-------------------|--------|------------|
| §1 Code Quality | — | Manual (code review) |
| §2 Responsive & Cross-Browser | `breakpoints` | ✅ Overflow + screenshots |
| §3 Performance | `lighthouse` | ✅ All metrics |
| §4 SEO | `seo` + `lighthouse` | ✅ Meta, OG, JSON-LD, scores |
| §5 CMS Integration | — | Manual |
| §6 Interactive Components | — | Manual (use Playwright interactively) |
| §7 Accessibility | `accessibility` | ✅ axe-core (partial — keyboard/focus need manual) |
| §8 Analytics & Consent | — | Manual |
| §9 Redirects & Routing | `redirects` | ✅ 301s, links, 404 |
| §10 Localisation | — | Manual |
| §11 Vercel & CI/CD | — | Visual check on Vercel dashboard |

---

## Vercel Preview Authentication

All scripts support Vercel's password-protected preview deployments. There are three ways to provide the password:

1. **CLI flag:** `--password mypass` (or `-p mypass`)
2. **Environment variable:** `export VERCEL_PREVIEW_PASSWORD=mypass`
3. **Prompted:** (not yet implemented — coming soon)

The scripts use Playwright to submit the Vercel password form, extract the auth cookie, then pass it to all subsequent tools (including Lighthouse, which runs in its own Chrome instance).

---

## Troubleshooting

**Lighthouse hangs or times out**
- Make sure Chrome is installed and accessible
- Try: `npx lighthouse --chrome-flags="--headless --no-sandbox" <url>`

**Playwright browsers not installed**
- Run: `npx playwright install`
- For specific browsers: `npx playwright install chromium webkit firefox`

**Vercel auth fails**
- Check that the password is correct
- Vercel's protection page markup may change — check `lib/vercel-auth.js`

**axe-core returns 0 results**
- The page may not have loaded fully — try increasing the wait timeout
- Check that the URL is accessible and returns HTML

---

## Project Structure

```
plasma-qa-tools/
├── package.json
├── README.md
├── lib/
│   ├── cli.js          # Shared CLI argument parsing
│   ├── config.js       # Plasma spec thresholds and breakpoints
│   ├── report.js       # Report formatting and saving
│   └── vercel-auth.js  # Vercel preview password handling
├── scripts/
│   ├── quick-check.js       # Combined fast check (every PR)
│   ├── lighthouse-audit.js  # Performance + SEO scores
│   ├── accessibility-audit.js # WCAG 2.1 AA via axe-core
│   ├── breakpoint-test.js   # Screenshots + overflow check
│   ├── seo-audit.js         # Meta tags, OG, JSON-LD, semantic HTML
│   └── redirect-checker.js  # 301s, links, 404 page
└── reports/                 # Generated reports (gitignored)
    └── screenshots/
```
