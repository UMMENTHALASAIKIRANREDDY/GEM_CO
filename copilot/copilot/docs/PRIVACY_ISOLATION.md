# Privacy and isolation: stakeholder review

Use this page for **compliance and security sign-off** when rolling out Copilot export migration and an org-wide agent.

## Goal

Archive Copilot interaction history into **retrieval-friendly** files (HTML + manifest) and optionally ground a **Microsoft Copilot Studio** agent on that content, **same tenant** as the source data.

## Isolation options

| Approach | Summary | Tradeoffs |
|----------|---------|-----------|
| **Per-user OneDrive** (this tool’s default path) | Each user’s files live under that user’s OneDrive (`ONEDRIVE_ROOT_FOLDER`, e.g. `CopilotMigration/`). | Aligns with “my data in my drive.” A **single** org-wide agent does **not** automatically enforce per-user knowledge isolation; users often rely on **Microsoft 365’s user-scoped search** over their own files when chatting. **Validate** with pilot users and your Microsoft contact. |
| **Shared knowledge library** | One SharePoint library or shared OneDrive folder attached to **one** agent. | Easier to manage one knowledge location; **higher** risk of cross-user exposure unless all content is intentionally shared or sanitized. |
| **Multiple agents or cohorts** | Separate agents or knowledge sources per group. | Better isolation boundaries; more operational overhead. |
| **Strict SharePoint permissions** | Per-user or per-group sites/libraries with fine-grained permissions. | Strongest structural isolation for shared repositories; requires SharePoint architecture work. |

## Application permissions

The migration CLI uses **application** permissions, including **`Files.ReadWrite.All`** for uploads to any user’s OneDrive. That capability is **tenant-wide** from the application’s perspective. Mitigations include minimal use of the secret, rotation, Conditional Access, and restricting **who** may run automation or call secured APIs.

## Data lifecycle

- **Retention**: align `manifest.json` and HTML files with records management and **retention** policies.
- **DLP**: consider **Data Loss Prevention** rules for the migration folder paths.
- **Deletion**: define what happens when a user leaves the company (OneDrive retention, agent knowledge refresh).

## Sign-off checklist

- [ ] Legal / privacy reviewed **per-user OneDrive** vs **shared KB** choice.  
- [ ] Security reviewed `Files.ReadWrite.All` and admin consent scope.  
- [ ] Pilot completed: no unintended cross-user answers from the agent for migrated content.  
- [ ] Help desk messaging for users (what was migrated, where it lives, how to request removal).  

This document is descriptive only; it does not constitute legal advice.
