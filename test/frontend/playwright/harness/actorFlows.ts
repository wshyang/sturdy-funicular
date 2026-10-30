// Actor flow helpers for Playwright tests
// Compatibility layer over existing actor/scenario helpers

import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';
import type { TestHarness } from './test';
import type { ActionOptions } from './pacing';

/**
 * Actor flow helper that uses the harness
 */
export class ActorFlows {
  private readonly harness: TestHarness;

  constructor(harness: TestHarness) {
    this.harness = harness;
  }

  /**
   * Get the underlying harness
   */
  getHarness(): TestHarness {
    return this.harness;
  }

  /**
   * Get the page
   */
  getPage(): Page {
    return this.harness.getPage();
  }

  /**
   * Login as a user
   */
  async login(
    email: string,
    password: string,
    testId: string = 'login',
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    
    // Fill email
    await this.harness.fillText(`${testId}-email`, page.getByTestId('login__email-input'), email, {
      ...options,
      preDelayMs: options?.preDelayMs ?? 0,
    });
    
    // Fill password
    await this.harness.fillText(`${testId}-password`, page.getByTestId('login__password-input'), password, {
      ...options,
      preDelayMs: 0,
    });
    
    // Click login button
    await this.harness.click(`${testId}-submit`, page.getByTestId('login__submit-button'), {
      ...options,
      preDelayMs: 0,
      waitForNetworkIdle: true,
    });
  }

  /**
   * Logout
   */
  async logout(testId: string = 'logout', options?: ActionOptions): Promise<void> {
    const page = this.getPage();
    await this.harness.click(testId, page.getByTestId('header__logout-button'), options);
  }

  /**
   * Navigate to a URL
   */
  async navigate(
    url: string,
    testId: string = 'navigate',
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    
    if (options?.capture) {
      // Capture before navigation
      const artifacts = await this.harness.captureFullPageShot(`${testId}-before`);
      // eslint-disable-next-line no-console -- artifact path trace for the runner log
      console.log(`Captured before navigation: ${String(artifacts)}`);
    }
    
    await this.harness.step(testId, async () => {
      await page.goto(url);
    }, options);
  }

  /**
   * Wait for an element to be visible
   */
  async waitForVisible(
    locator: Locator,
    testId: string = 'wait-for-visible',
    options?: ActionOptions
  ): Promise<void> {
    await this.harness.step(testId, async () => {
      await locator.waitFor({ state: 'visible' });
    }, options);
  }

  /**
   * Wait for an element to be hidden
   */
  async waitForHidden(
    locator: Locator,
    testId: string = 'wait-for-hidden',
    options?: ActionOptions
  ): Promise<void> {
    await this.harness.step(testId, async () => {
      await locator.waitFor({ state: 'hidden' });
    }, options);
  }

  /**
   * Click a button by test ID
   */
  async clickButton(
    testId: string,
    buttonTestId: string,
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    await this.harness.click(testId, page.getByTestId(buttonTestId), options);
  }

  /**
   * Fill a form field by test ID
   */
  async fillField(
    testId: string,
    fieldTestId: string,
    value: string,
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    await this.harness.fillText(testId, page.getByTestId(fieldTestId), value, options);
  }

  /**
   * Select an option from a dropdown by test ID
   */
  async selectOption(
    testId: string,
    selectTestId: string,
    valueOrLabel: string | { label?: string; value?: string; index?: number },
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    await this.harness.selectOption(testId, page.getByTestId(selectTestId), valueOrLabel, options);
  }

  /**
   * Submit a form by test ID
   */
  async submitForm(
    testId: string,
    formTestId: string,
    options?: ActionOptions
  ): Promise<void> {
    const page = this.getPage();
    await this.harness.submit(testId, page.getByTestId(formTestId), {
      ...options,
      waitForNetworkIdle: true,
    });
  }

  /**
   * Assert that an element contains text
   */
  async assertText(
    locator: Locator,
    expectedText: string | RegExp,
    testId: string = 'assert-text'
  ): Promise<void> {
    await this.harness.step(testId, async () => {
      await expect(locator).toContainText(expectedText);
    });
  }

  /**
   * Assert that an element is visible
   */
  async assertVisible(
    locator: Locator,
    testId: string = 'assert-visible'
  ): Promise<void> {
    await this.harness.step(testId, async () => {
      await expect(locator).toBeVisible();
    });
  }

  /**
   * Assert that an element is not visible
   */
  async assertNotVisible(
    locator: Locator,
    testId: string = 'assert-not-visible'
  ): Promise<void> {
    await this.harness.step(testId, async () => {
      await expect(locator).not.toBeVisible();
    });
  }

  /**
   * Assert URL matches expected pattern
   */
  async assertUrl(
    expectedUrl: string | RegExp,
    testId: string = 'assert-url'
  ): Promise<void> {
    const page = this.getPage();
    await this.harness.step(testId, async () => {
      await expect(page).toHaveURL(expectedUrl);
    });
  }
}
