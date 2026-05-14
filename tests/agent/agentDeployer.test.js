import { AgentDeployer } from '../../src/agent/agentDeployer.js';
import AdmZip from 'adm-zip';

function getAgentManifest(deployer) {
  const zip = new AdmZip(deployer._buildAppPackage());
  return JSON.parse(zip.readAsText('declarativeAgent.json'));
}

test('declarativeAgent.json has no welcome_message (not supported in schema v1.5)', () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = getAgentManifest(deployer);
  expect(manifest.welcome_message).toBeUndefined();
});

test('instructions tell agent to list conversations on open', () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = getAgentManifest(deployer);
  expect(manifest.instructions).toContain('list all pages');
  expect(manifest.instructions).toContain('numbered list');
});

test('instructions tell agent to load full page content when user picks a conversation', () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = getAgentManifest(deployer);
  expect(manifest.instructions).toContain('full content');
});

test('conversation starters include history trigger', () => {
  const deployer = new AgentDeployer('Acme', 'tenant-abc', {}, null);
  const manifest = getAgentManifest(deployer);
  const texts = manifest.conversation_starters.map(s => s.text.toLowerCase());
  expect(texts.some(t => t.includes('history') || t.includes('conversations') || t.includes('list'))).toBe(true);
});
