/**
 * Microsoft Graph aiInteraction appClass values (Copilot surfaces).
 * @see https://learn.microsoft.com/graph/api/aiinteractionhistory-getallenterpriseinteractions
 */

export const APP_CLASS = {
  BizChat: "IPM.SkypeTeams.Message.Copilot.BizChat",
  WebChat: "IPM.SkypeTeams.Message.Copilot.WebChat",
  Teams: "IPM.SkypeTeams.Message.Copilot.Teams",
  Word: "IPM.SkypeTeams.Message.Copilot.Word",
  Excel: "IPM.SkypeTeams.Message.Copilot.Excel",
};

/** Microsoft 365 Copilot Chat (browser/app) + Copilot web chat — excludes Teams meetings, Word, Excel, etc. */
const COPILOT_CHAT_SURFACES = [APP_CLASS.BizChat, APP_CLASS.WebChat];

/**
 * OData $filter: only BizChat + WebChat.
 */
export function buildCopilotChatOnlyFilter() {
  const [a, b] = COPILOT_CHAT_SURFACES;
  return `(appClass eq '${a}' or appClass eq '${b}')`;
}

export function isCopilotChatSurface(appClass) {
  if (appClass == null || appClass === "") {
    return false;
  }
  return COPILOT_CHAT_SURFACES.includes(String(appClass));
}
