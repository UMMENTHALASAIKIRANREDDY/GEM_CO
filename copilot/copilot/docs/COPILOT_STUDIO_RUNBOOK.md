# Copilot Studio agent: knowledge, deployment, and visibility

This runbook complements the **OneDrive migration** in this repo. It describes **administrator steps** in Microsoft Copilot Studio and Microsoft 365 admin experiences. Behavior and UI labels can change; always verify against current Microsoft documentation.

## 1. Create or extend an agent

1. Open [Microsoft Copilot Studio](https://copilotstudio.microsoft.com/) with an account that can build agents for your tenant.
2. Create an agent (or use an existing one) intended for **organization-wide** use.
3. In **Instructions**, state that answers should **prefer** migrated Copilot archive content when it is relevant, and define tone, safety, and when to refuse or escalate.

## 2. Attach knowledge

Copilot Studio can use various knowledge sources. For content this tool uploads to OneDrive:

- **Per-user OneDrive folders**: suitable when each user’s archive lives under that user’s own account (for example `CopilotMigration/`). Grounding may rely on **that user’s** Microsoft 365 search over their files when the user chats—validate in a pilot.
- **Shared library**: a **SharePoint site** or **shared OneDrive folder** can be attached as knowledge for **one** org-wide agent; this is simpler operationally but is **not** per-user isolation unless combined with permission design (separate sites/libraries per cohort, and so on).

Prefer **HTML** (and optional **PDF**) in the knowledge location; native **OneNote notebooks** are a different Graph surface and are not what this repository uploads.

## 3. Deploy to the organization

Follow Microsoft’s agent lifecycle documentation for publishing and availability:

- [Deploy agents for Microsoft 365 Copilot](https://learn.microsoft.com/en-us/copilot/microsoft-365/agent-essentials/agent-lifecycle/agent-deploy)

Complete **Publish** steps in Copilot Studio, then use **Microsoft 365 admin center** / **Copilot admin** controls so the right users or groups can access the agent, according to your license and rollout plan.

## 4. Pinning and sidebar visibility

**Pinning** custom agents for users is governed by **Microsoft 365 administrator policies** (for example visibility of Copilot Chat and custom agents), not by this Node.js application. Plan for:

- Roles such as **AI Administrator** or **Copilot administrator** (as defined in your tenant).
- Pilot groups before org-wide rollout.
- Documentation for help desk and change management.

There is no supported guarantee that a single API call from this repo will “pin” an agent for every user without admin center configuration; treat admin steps as required.

## 5. Operational checks

- After migration, spot-check a few users’ OneDrive paths (`ONEDRIVE_ROOT_FOLDER`, default `CopilotMigration`) for `manifest.json` and `sessions/*.html`.
- Test the agent with questions that should retrieve migrated content and questions that should **not** leak another user’s data (see `docs/PRIVACY_ISOLATION.md`).
