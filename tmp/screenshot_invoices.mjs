#!/usr/bin/env node
/**
 * Playwright script to screenshot jolo invoices pages.
 * Run with: node --experimental-vm-modules screenshot_invoices.mjs
 * Or via: npx -y playwright@latest node screenshot_invoices.mjs
 *
 * Requires playwright to be installed:
 *   npm install -g playwright  OR  npm install playwright (in project)
 *   npx playwright install chromium
 */

// Encode password: Ayla2022!@TL!
const PASSWORD_B64 = "QXlsYTIwMjIhQFRMIQ==";
const PASSWORD = Buffer.from(PASSWORD_B64, "base64").toString("utf8");
const EMAIL = "nagolpj@gmail.com";
const BASE_URL = "http://127.0.0.1:5173";
const OUT_DIR = "/Users/jaylogan/Projects/gojolo-application/tmp";

import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import path from "path";

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });

  const page = await ctx.newPage();

  const ss = (name) =>
    page.screenshot({
      path: path.join(OUT_DIR, name),
      fullPage: true,
    });

  try {
    // ── 1. Load login page ────────────────────────────────────────────────
    console.log("[1] Loading login page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1500);
    console.log(`    URL: ${page.url()}`);
    await ss("ss-00-login-initial.png");

    // ── 2. Switch to email/password mode ──────────────────────────────────
    console.log("[2] Switching to email/password mode...");
    const switchBtn = page.getByTestId("login-switch-email");
    const switchCnt = await switchBtn.count();
    console.log(`    Switch button found: ${switchCnt > 0}`);

    if (switchCnt > 0) {
      await switchBtn.click();
      await page.waitForTimeout(500);
    }

    await ss("ss-01-email-mode.png");

    // ── 3. Fill credentials ───────────────────────────────────────────────
    console.log("[3] Filling credentials...");
    const emailInput = page.getByTestId("login-email-input");
    const pwInput = page.getByTestId("login-password-input");
    const emailCnt = await emailInput.count();
    const pwCnt = await pwInput.count();
    console.log(`    Email input found: ${emailCnt > 0}`);
    console.log(`    Password input found: ${pwCnt > 0}`);

    if (emailCnt > 0) {
      await emailInput.fill(EMAIL);
    } else {
      await page.locator('input[type="email"]').first().fill(EMAIL);
    }

    if (pwCnt > 0) {
      await pwInput.fill(PASSWORD);
    } else {
      await page.locator('input[type="password"]').first().fill(PASSWORD);
    }

    await ss("ss-02-credentials-filled.png");

    // ── 4. Submit ─────────────────────────────────────────────────────────
    console.log("[4] Submitting login...");
    const submitBtn = page.getByTestId("login-email-submit");
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
    } else {
      await page.locator('button[type="submit"]').first().click();
    }

    // Wait for redirect away from /login
    let loginSucceeded = false;
    try {
      await page.waitForURL((url) => !url.includes("/login"), { timeout: 15000 });
      loginSucceeded = true;
      console.log(`    ✅ Login succeeded! URL: ${page.url()}`);
    } catch {
      console.log(`    ❌ Still on login after 15s. URL: ${page.url()}`);
      // Check for error message
      const msgEl = page.getByTestId("login-message");
      if (await msgEl.count() > 0) {
        const msgText = await msgEl.textContent();
        console.log(`    Error message: ${msgText}`);
      }
    }

    await page.waitForTimeout(2000);
    await ss("ss-03-after-login.png");

    if (!loginSucceeded) {
      console.log("    Login failed — capturing login state and exiting");
      await browser.close();
      return;
    }

    // ── 5. Handle workspace picker if shown ───────────────────────────────
    if (page.url().includes("/workspace")) {
      console.log("[5] On workspace picker — selecting 'Brogrammers Agency'...");
      await page.waitForTimeout(1000);
      await ss("ss-04-workspace-picker.png");

      // Try to find and click the workspace
      const orgBtn = page.locator('button:has-text("Brogrammers"), button:has-text("brogrammers")').first();
      if (await orgBtn.count() > 0) {
        await orgBtn.click();
        await page.waitForURL((url) => !url.includes("/workspace"), { timeout: 10000 });
        console.log(`    Workspace selected, URL: ${page.url()}`);
      } else {
        // Just click the first org button
        const firstOrg = page.locator('[data-testid*="org"], button').filter({ hasText: /Agency|Corp|Inc|LLC|Bro/i }).first();
        if (await firstOrg.count() > 0) {
          await firstOrg.click();
          await page.waitForTimeout(2000);
        } else {
          // Try any button on workspace page
          const anyBtn = page.locator('button').first();
          if (await anyBtn.count() > 0) {
            const btnText = await anyBtn.textContent();
            console.log(`    Clicking first button: ${btnText}`);
            await anyBtn.click();
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    // ── 6. Navigate to /invoices ──────────────────────────────────────────
    console.log("[6] Navigating to /invoices...");
    await page.goto(`${BASE_URL}/invoices`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);
    console.log(`    URL: ${page.url()}`);

    if (page.url().includes("/login")) {
      console.log("    ❌ Redirected back to login — session lost");
      await ss("ss-invoice-list.png");
      await browser.close();
      return;
    }

    // Wait for content
    try {
      await page.waitForSelector('[data-testid="invoice-form"], table, h1, .text-white', {
        timeout: 8000,
      });
    } catch {
      // Continue anyway
    }
    await page.waitForTimeout(1000);

    await ss("ss-invoice-list.png");
    console.log(`    ✅ Saved ss-invoice-list.png`);

    // ── 7. Check for existing invoices ────────────────────────────────────
    console.log("[7] Looking for existing invoices...");
    let invoiceDetailSaved = false;

    for (const sel of [
      "table tbody tr",
      "tbody tr",
      '[data-testid*="invoice-row"]',
      '[data-testid*="invoice-item"]',
    ]) {
      const rows = page.locator(sel);
      const cnt = await rows.count();
      if (cnt > 0) {
        console.log(`    Found ${cnt} rows via: ${sel}`);
        await rows.first().click();
        await page.waitForLoadState("networkidle", { timeout: 10000 });
        await page.waitForTimeout(1500);
        console.log(`    Clicked -> ${page.url()}`);
        await ss("ss-invoice-detail.png");
        console.log(`    ✅ Saved ss-invoice-detail.png`);
        invoiceDetailSaved = true;
        break;
      }
    }

    if (!invoiceDetailSaved) {
      console.log("    No invoice rows found");
    }

    // ── 8. Open New Invoice form ──────────────────────────────────────────
    console.log("[8] Opening New Invoice form...");

    // Navigate back to invoices list
    await page.goto(`${BASE_URL}/invoices`, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(1500);

    let newFormOpened = false;
    for (const sel of [
      'button:has-text("New Invoice")',
      'a:has-text("New Invoice")',
      'button:has-text("New")',
      'a[href*="/invoices/new"]',
      'button:has-text("Create")',
      'button:has-text("Add")',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        const txt = await el.textContent();
        console.log(`    Clicking: ${txt?.trim()} (selector: ${sel})`);
        await el.click();
        await page.waitForLoadState("networkidle", { timeout: 10000 });
        await page.waitForTimeout(2000);
        console.log(`    URL: ${page.url()}`);
        newFormOpened = true;
        break;
      }
    }

    if (!newFormOpened) {
      console.log("    No button found, navigating directly to /invoices/new");
      await page.goto(`${BASE_URL}/invoices/new`, {
        waitUntil: "networkidle",
        timeout: 15000,
      });
      await page.waitForTimeout(2000);
      console.log(`    URL: ${page.url()}`);
    }

    await ss("ss-invoice-form.png");
    console.log(`    ✅ Saved ss-invoice-form.png`);

    // ── 9. Scroll to recurring section ────────────────────────────────────
    console.log("[9] Looking for Recurring / Import from Time Logs section...");
    for (const sel of [
      'text=Recurring',
      'label:has-text("Recurring")',
      'text=Import from Time Logs',
      'button:has-text("Import from Time")',
      '[class*="recurring"]',
    ]) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(600);
        console.log(`    Scrolled to: ${sel}`);
        await page.screenshot({
          path: path.join(OUT_DIR, "ss-invoice-form-recurring.png"),
          fullPage: false,
        });
        console.log(`    ✅ Saved ss-invoice-form-recurring.png`);
        break;
      }
    }

    // Also take a full-page shot to ensure we got everything
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await ss("ss-invoice-form-top.png");

    // Scroll halfway
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(OUT_DIR, "ss-invoice-form-mid.png"),
      fullPage: false,
    });

    console.log("\n=== COMPLETE ===");
    console.log(`Login succeeded: ${loginSucceeded}`);
    console.log(`Invoice detail saved: ${invoiceDetailSaved}`);
    console.log(`Output: ${OUT_DIR}`);
  } catch (err) {
    console.error("Fatal error:", err);
    await ss("ss-error-state.png").catch(() => {});
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
