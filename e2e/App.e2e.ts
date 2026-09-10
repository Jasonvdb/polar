import { afterEach, getPageTitle, pageUrl } from './helpers';

fixture`App`.page(pageUrl).afterEach(afterEach);

test('should have correct title', async t => {
  await t.expect(getPageTitle()).eql('Polar Paykit');
});
