import { test, expect } from '@playwright/test';

test.describe('homepage', () => {
  test('loads with expected title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Alex Isken');
  });

  test('shows main intro heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.intro')).toContainText("Hi, I'm Alex.");
  });

  test('LinkedIn nav link has correct href', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Linkedin' });
    await expect(link).toHaveAttribute('href', 'https://www.linkedin.com/in/alexisken/');
  });

  test('GitHub nav link has correct href', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'GitHub' });
    await expect(link).toHaveAttribute('href', 'https://github.com/alexisken');
  });

  test('Resume link points to PDF and PDF is reachable', async ({ page, request }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Resume' });
    await expect(link).toHaveAttribute('href', "assets/resume/AI's Resume.pdf");

    const res = await request.get("/assets/resume/AI's%20Resume.pdf");
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
  });

  test('stylesheet is reachable', async ({ request }) => {
    const res = await request.get('/assets/css/styles.css');
    expect(res.status()).toBe(200);
  });

  test('no uncaught page errors on load', async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (err) => errors.push(err));
    await page.goto('/');
    await page.waitForLoadState('load');
    expect(errors).toEqual([]);
  });
});
