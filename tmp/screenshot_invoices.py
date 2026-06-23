#!/usr/bin/env python3
"""
Playwright script to log into jolo app and take invoice screenshots.
Uses data-testid selectors discovered from source code.
"""

import asyncio
import base64
import sys
from pathlib import Path

OUTPUT_DIR = Path("/Users/jaylogan/Projects/gojolo-application/tmp")
EMAIL = "nagolpj@gmail.com"
# Password: Ayla2022!@TL!
PASSWORD = base64.b64decode("QXlsYTIwMjIhQFRMIQ==").decode()
BASE_URL = "http://127.0.0.1:5173"


async def run():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("ERROR: playwright not installed.")
        print("Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            ignore_https_errors=True,
        )
        page = await context.new_page()

        # ── Step 1: Load login page ───────────────────────────────────────────
        print(f"[1] Navigating to {BASE_URL}/login ...")
        await page.goto(f"{BASE_URL}/login", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        print(f"    URL: {page.url} | Title: {await page.title()}")

        await page.screenshot(path=str(OUTPUT_DIR / "ss-01-login-page.png"), full_page=True)
        print("    Saved ss-01-login-page.png")

        # ── Step 2: Switch to email/password mode ─────────────────────────────
        print("[2] Clicking 'Sign in with email & password'...")
        switch_btn = page.get_by_test_id("login-switch-email")
        cnt = await switch_btn.count()
        print(f"    Found switch button: {cnt > 0}")
        if cnt > 0:
            await switch_btn.click()
            await page.wait_for_timeout(500)
        else:
            print("    WARNING: switch-email button not found, trying visible text")
            await page.locator('button:has-text("email")').first.click()
            await page.wait_for_timeout(500)

        await page.screenshot(path=str(OUTPUT_DIR / "ss-02-email-mode.png"), full_page=True)
        print("    Saved ss-02-email-mode.png")

        # ── Step 3: Fill email ────────────────────────────────────────────────
        print("[3] Filling email and password...")
        email_input = page.get_by_test_id("login-email-input")
        email_cnt = await email_input.count()
        print(f"    Email input found: {email_cnt > 0}")

        if email_cnt > 0:
            await email_input.fill(EMAIL)
        else:
            await page.locator('input[type="email"]').first.fill(EMAIL)

        pw_input = page.get_by_test_id("login-password-input")
        pw_cnt = await pw_input.count()
        print(f"    Password input found: {pw_cnt > 0}")

        if pw_cnt > 0:
            await pw_input.fill(PASSWORD)
        else:
            await page.locator('input[type="password"]').first.fill(PASSWORD)

        # ── Step 4: Submit ────────────────────────────────────────────────────
        print("[4] Clicking Sign In...")
        submit_btn = page.get_by_test_id("login-email-submit")
        if await submit_btn.count() > 0:
            await submit_btn.click()
        else:
            await page.locator('button[type="submit"]').first.click()

        # Wait for navigation away from login
        try:
            await page.wait_for_url(lambda url: "/login" not in url, timeout=15000)
            login_succeeded = True
        except Exception:
            login_succeeded = False

        await page.wait_for_timeout(2000)
        print(f"    After submit URL: {page.url}")
        print(f"    Login succeeded: {login_succeeded}")

        await page.screenshot(path=str(OUTPUT_DIR / "ss-03-after-login.png"), full_page=True)
        print("    Saved ss-03-after-login.png")

        # Check for error message
        msg = page.get_by_test_id("login-message")
        if await msg.count() > 0:
            msg_text = await msg.text_content()
            print(f"    Login message: {msg_text}")

        # ── Step 5: Navigate to Invoices ──────────────────────────────────────
        print(f"\n[5] Navigating to invoices...")

        if not login_succeeded:
            print("    Login failed — trying direct URL anyway...")

        await page.goto(f"{BASE_URL}/invoices", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(2000)
        print(f"    URL: {page.url}")

        # If redirected back to login, we're not authenticated
        if "/login" in page.url:
            print("    ⚠ Redirected to login — not authenticated!")
            await page.screenshot(path=str(OUTPUT_DIR / "ss-invoice-list.png"), full_page=True)
            print("    Saved ss-invoice-list.png (showing login redirect)")
            await browser.close()
            _print_summary(login_succeeded, OUTPUT_DIR)
            return

        # Wait for invoice list to render
        try:
            await page.wait_for_load_state("networkidle", timeout=10000)
        except Exception:
            pass
        await page.wait_for_timeout(1500)

        await page.screenshot(path=str(OUTPUT_DIR / "ss-invoice-list.png"), full_page=True)
        print(f"    ✅ Saved ss-invoice-list.png")

        # ── Step 6: Check for existing invoices ───────────────────────────────
        print(f"\n[6] Looking for existing invoices to click...")

        invoice_detail_saved = False
        invoice_selectors = [
            'table tbody tr',
            '[data-testid*="invoice-row"]',
            '[data-testid*="invoice-item"]',
            'tbody tr',
            '.invoice-row',
        ]

        for sel in invoice_selectors:
            try:
                rows = page.locator(sel)
                cnt = await rows.count()
                if cnt > 0:
                    print(f"    Found {cnt} rows with: {sel}")
                    first_row = rows.first
                    await first_row.click()
                    await page.wait_for_load_state("networkidle", timeout=10000)
                    await page.wait_for_timeout(1500)
                    print(f"    Clicked -> {page.url}")
                    await page.screenshot(path=str(OUTPUT_DIR / "ss-invoice-detail.png"), full_page=True)
                    print(f"    ✅ Saved ss-invoice-detail.png")
                    invoice_detail_saved = True
                    break
            except Exception as e:
                print(f"    Error with {sel}: {e}")

        if not invoice_detail_saved:
            print("    No invoice rows found to click")

        # ── Step 7: Navigate back to invoices and open New Invoice form ───────
        print(f"\n[7] Going to New Invoice form...")

        await page.goto(f"{BASE_URL}/invoices", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(1500)

        # Look for New Invoice button
        new_btn_selectors = [
            '[data-testid*="new-invoice"]',
            'button:has-text("New Invoice")',
            'a:has-text("New Invoice")',
            'button:has-text("New")',
            'a[href*="/invoices/new"]',
            'button:has-text("Create")',
        ]

        new_btn_found = False
        for sel in new_btn_selectors:
            try:
                el = page.locator(sel).first
                if await el.count() > 0:
                    print(f"    Found new button: {sel}")
                    await el.click()
                    await page.wait_for_load_state("networkidle", timeout=10000)
                    await page.wait_for_timeout(2000)
                    print(f"    Navigated to: {page.url}")
                    new_btn_found = True
                    break
            except Exception as e:
                print(f"    Error {sel}: {e}")

        if not new_btn_found:
            print("    Trying direct URL /invoices/new ...")
            await page.goto(f"{BASE_URL}/invoices/new", wait_until="networkidle", timeout=15000)
            await page.wait_for_timeout(2000)
            print(f"    URL: {page.url}")

        # Full page screenshot of new invoice form
        await page.screenshot(path=str(OUTPUT_DIR / "ss-invoice-form.png"), full_page=True)
        print(f"    ✅ Saved ss-invoice-form.png")

        # Try to find and scroll to recurring / time logs section
        print("\n[8] Scrolling to recurring / Import from Time Logs section...")
        try:
            recurring_selectors = [
                'text=Recurring',
                'text=recurring',
                'text=Import from Time',
                'text=Time Log',
                '[class*="recurring"]',
                'label:has-text("Recurring")',
            ]
            found_recurring = False
            for sel in recurring_selectors:
                el = page.locator(sel).first
                if await el.count() > 0:
                    await el.scroll_into_view_if_needed()
                    await page.wait_for_timeout(600)
                    print(f"    Found section: {sel}")
                    await page.screenshot(path=str(OUTPUT_DIR / "ss-invoice-form-recurring.png"), full_page=False)
                    print(f"    ✅ Saved ss-invoice-form-recurring.png (viewport)")
                    found_recurring = True
                    break
            if not found_recurring:
                print("    Recurring section not found on visible page")
        except Exception as e:
            print(f"    Note: {e}")

        await browser.close()
        _print_summary(login_succeeded, OUTPUT_DIR)


def _print_summary(login_succeeded, output_dir):
    print("\n" + "=" * 50)
    print("FINAL SUMMARY")
    print("=" * 50)
    print(f"Login succeeded: {login_succeeded}")
    print(f"Output dir: {output_dir}")
    pngs = sorted(output_dir.glob("ss-*.png"))
    if pngs:
        print(f"\nScreenshots ({len(pngs)}):")
        for f in pngs:
            sz = f.stat().st_size
            print(f"  {f}  ({sz:,} bytes)")
    else:
        print("  No screenshots saved!")


if __name__ == "__main__":
    asyncio.run(run())
