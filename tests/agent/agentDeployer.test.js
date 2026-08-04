import { AgentDeployer } from '../../src/agent/agentDeployer.js';
import AdmZip from 'adm-zip';

async function getAgentManifest(deployer) {
  const zip = new AdmZip(await deployer._buildAppPackage());
  return JSON.parse(zip.readAsText('declarativeAgent.json'));
}

test('declarativeAgent.json has no welcome_message (not supported in schema v1.5)', async () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = await getAgentManifest(deployer);
  expect(manifest.welcome_message).toBeUndefined();
});

test('instructions tell agent to search OneDrive conversation history', async () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = await getAgentManifest(deployer);
  expect(manifest.instructions).toContain('numbered list');
  expect(manifest.instructions).toContain('OneDrive');
});

test('instructions tell agent to load full conversation content when user picks one', async () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = await getAgentManifest(deployer);
  expect(manifest.instructions).toContain('Display the conversation content');
});

test('conversation starters include history trigger', async () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = await getAgentManifest(deployer);
  const texts = manifest.conversation_starters.map(s => s.text.toLowerCase());
  expect(texts.some(t => t.includes('history') || t.includes('conversations') || t.includes('list'))).toBe(true);
});

test('color.png and outline.png are real PNGs at the exact required Teams dimensions', async () => {
  const sharp = (await import('sharp')).default;
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const zip = new AdmZip(await deployer._buildAppPackage());

  const color = await sharp(zip.readFile('color.png')).metadata();
  expect(color.width).toBe(192);
  expect(color.height).toBe(192);

  const outline = await sharp(zip.readFile('outline.png')).metadata();
  expect(outline.width).toBe(32);
  expect(outline.height).toBe(32);
});
