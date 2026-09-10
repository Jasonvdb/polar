import { afterEach, getPageUrl, pageUrl } from './helpers';
import { Home } from './pages';

fixture`Import`.page(pageUrl).beforeEach(Home.clickImportButton).afterEach(afterEach);

test('should be on the import network route', async t => {
  await t.expect(getPageUrl()).match(/network_import/);
});
