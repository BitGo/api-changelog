const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Generate Release Description', async () => {
  const scenarios = fs.readdirSync(FIXTURES_DIR);

  beforeEach(() => {
    // Clean up any existing output files
    if (fs.existsSync('release-description.md')) {
      fs.unlinkSync('release-description.md');
    }
  });

  scenarios.forEach(scenario => {
    it(`handles ${scenario} correctly`, () => {
      // Copy fixture files to working directory
      const scenarioDir = path.join(FIXTURES_DIR, scenario);
      fs.copyFileSync(
        path.join(scenarioDir, 'previous.json'),
        'previous.json'
      );
      fs.copyFileSync(
        path.join(scenarioDir, 'current.json'),
        'current.json'
      );

      // Run the script
      execSync('node scripts/api-diff.js');

      // Compare output with expected
      const actual = fs.readFileSync('release-description.md', 'utf8').trim();
      const expected = fs.readFileSync(
        path.join(scenarioDir, 'expected.md'),
        'utf8'
      ).trim();

      assert.strictEqual(actual, expected);
    });
  });

  afterEach(() => {
    // Clean up test files
    ['previous.json', 'current.json', 'release-description.md'].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });
});
