import { ClientFunction } from 'testcafe';
import { cleanupNetworks } from '../../scripts/e2e-environment';

export const pageUrl = '../build/index.html';

export const getPageUrl = ClientFunction(() => window.location.href);
export const getPageTitle = ClientFunction(() => document.title);

export const assertNoConsoleErrors = async (t: TestController) => {
  const { error } = await t.getBrowserConsoleMessages();
  await t.expect(error).eql([]);
};

export const cleanup = async () => {
  cleanupNetworks();
};

export const afterEach = async (t: TestController) => {
  try {
    await assertNoConsoleErrors(t);
  } finally {
    await cleanup();
  }
};
