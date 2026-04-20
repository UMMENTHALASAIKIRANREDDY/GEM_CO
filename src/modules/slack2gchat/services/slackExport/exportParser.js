import fs from 'fs';
import path from 'path';

/**
 * Parse a Slack export directory into structured metadata.
 * Reads channels.json, users.json, dms.json, groups.json, mpims.json.
 * Does NOT read message files (too large — handled by messageIterator).
 */
export async function parseSlackExport(exportDir) {
  const read = (file) => {
    const p = path.join(exportDir, file);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };

  const users = read('users.json');
  const channels = read('channels.json');
  const dms = read('dms.json');
  const groups = read('groups.json');
  const mpims = read('mpim.json').concat(read('mpims.json'));

  // Normalize channels
  const normalizedChannels = channels.map(c => ({
    slackChannelId: c.id,
    slackName: c.name,
    slackType: 'channel',
    isArchived: c.is_archived || false,
    memberIds: c.members || [],
    topic: c.topic?.value || '',
    purpose: c.purpose?.value || '',
  }));

  // Normalize DMs (2-person)
  const normalizedDms = dms.map(d => ({
    slackChannelId: d.id,
    slackName: `dm_${d.members?.join('_') || d.id}`,
    slackType: 'dm',
    isArchived: false,
    memberIds: d.members || [],
    topic: '',
    purpose: '',
  }));

  // Normalize group DMs / MPIMs
  const normalizedGroups = [...groups, ...mpims].map(g => ({
    slackChannelId: g.id,
    slackName: g.name || `group_${g.id}`,
    slackType: g.members?.length === 2 ? 'dm' : 'group_dm',
    isArchived: g.is_archived || false,
    memberIds: g.members || [],
    topic: g.topic?.value || '',
    purpose: g.purpose?.value || '',
  }));

  // Normalize users
  const normalizedUsers = users.map(u => ({
    slackUserId: u.id,
    slackName: u.name,
    slackRealName: u.real_name || u.profile?.real_name || '',
    slackEmail: u.profile?.email || '',
    displayName: u.profile?.display_name || u.real_name || u.name,
    isBot: u.is_bot || u.id === 'USLACKBOT',
    isDeleted: u.deleted || false,
    avatarUrl: u.profile?.image_72 || '',
  }));

  // Count messages per channel by scanning directory names
  const allChannels = [...normalizedChannels, ...normalizedDms, ...normalizedGroups];
  const channelMessageCounts = {};
  for (const ch of allChannels) {
    const chDir = path.join(exportDir, ch.slackName);
    if (fs.existsSync(chDir)) {
      const dayFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json'));
      let total = 0;
      for (const f of dayFiles) {
        try {
          const msgs = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
          total += Array.isArray(msgs) ? msgs.length : 0;
        } catch {}
      }
      channelMessageCounts[ch.slackChannelId] = total;
    } else {
      channelMessageCounts[ch.slackChannelId] = 0;
    }
  }

  return {
    users: normalizedUsers,
    channels: allChannels.map(c => ({
      ...c,
      messageCount: channelMessageCounts[c.slackChannelId] || 0,
    })),
    stats: {
      totalUsers: normalizedUsers.length,
      totalChannels: normalizedChannels.length,
      totalDms: normalizedDms.length,
      totalGroups: normalizedGroups.length,
      totalMessages: Object.values(channelMessageCounts).reduce((a, b) => a + b, 0),
    },
  };
}
