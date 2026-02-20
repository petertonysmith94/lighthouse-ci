/**
 * Vercel Preview Authentication
 *
 * Vercel password-protected previews work by setting a cookie after
 * the password form is submitted. This module handles that flow for
 * both Playwright (browser-based tools) and HTTP-based tools (Lighthouse).
 *
 * Usage:
 *   const { authenticatedPage } = await vercelAuth(browser, url, password);
 *   // page is now past the password gate
 *
 * For Lighthouse (which uses its own Chrome instance), we extract the
 * auth cookie after Playwright authenticates, then pass it through.
 */

import { chromium } from 'playwright';

/**
 * Authenticate with a Vercel preview deployment.
 * Returns a Playwright page that's past the password gate,
 * plus the auth cookies for use with other tools.
 */
export async function vercelAuth(browser, url, password) {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Check if we hit the Vercel password protection page
  const isProtected = await page.locator('input[type="password"]').count() > 0;

  if (isProtected && password) {
    console.log('  → Vercel preview is password-protected, authenticating...');
    await page.locator('input[type="password"]').fill(password);

    // Vercel's protection page has a "Visit" or submit button
    const submitButton = page.locator('button[type="submit"], button:has-text("Visit")');
    if (await submitButton.count() > 0) {
      await submitButton.first().click();
    } else {
      await page.locator('input[type="password"]').press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
    console.log('  → Authenticated successfully');
  } else if (isProtected && !password) {
    throw new Error(
      'Vercel preview is password-protected but no password provided.\n' +
      'Use --password <password> or set VERCEL_PREVIEW_PASSWORD env var.'
    );
  }

  // Extract cookies for use with non-Playwright tools (e.g. Lighthouse)
  const cookies = await context.cookies();

  return { page, context, cookies };
}

/**
 * Get a standalone authenticated browser + page.
 * Caller is responsible for closing the browser.
 */
export async function getAuthenticatedBrowser(url, password, options = {}) {
  const browser = await chromium.launch({
    headless: options.headless !== false,
  });

  const { page, context, cookies } = await vercelAuth(browser, url, password);

  return { browser, page, context, cookies };
}

/**
 * Format cookies for Lighthouse's --extra-headers or Chrome flags.
 * Returns a cookie string like "name1=val1; name2=val2"
 */
export function cookiesToString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Format cookies for Lighthouse's Chrome flags (--extra-headers).
 */
export function cookiesToLighthouseHeaders(cookies) {
  return JSON.stringify({ Cookie: cookiesToString(cookies) });
}
