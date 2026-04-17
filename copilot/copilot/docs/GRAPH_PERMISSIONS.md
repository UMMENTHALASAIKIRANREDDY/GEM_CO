# Microsoft Graph permissions for this project

Use **two** Entra ID (Azure AD) **application** registrations in **two different tenants** for cross-tenant migration:

- **Source** (`SOURCE_AZURE_*` or legacy `AZURE_*`): read Copilot interactions from the source tenant.
- **Destination** (`DEST_AZURE_*`): list destination users and upload to OneDrive in the destination tenant.

The **source tenant ID and destination tenant ID must not be equal.**

## Source app (read Copilot + list source users)

| Permission (application) | Purpose |
|--------------------------|---------|
| `AiEnterpriseInteraction.Read.All` | Read enterprise Copilot interaction history via Graph. |
| `User.Read.All` | List users in the source tenant for export and mapping. |

## Destination app (OneDrive upload + list destination users)

| Permission (application) | Purpose |
|--------------------------|---------|
| `User.Read.All` | List users in the destination tenant for mapping. |
| `Files.ReadWrite.All` | Create folders and upload files in **any user’s** OneDrive in the **destination** tenant. |

Admin consent each app in its own tenant.

### Risk and least privilege

`Files.ReadWrite.All` on the destination app is **highly sensitive**. Restrict who can deploy credentials, run the CLI, or call `POST /api/migrate/onedrive` (protected by `MIGRATE_API_KEY`).

### Token scope

Each app uses client credentials against its own tenant. Tokens are requested with `https://graph.microsoft.com/.default`.

## Troubleshooting

- **403** on upload: confirm `Files.ReadWrite.All` on the **destination** app and admin consent in the **destination** tenant.
- **Source and destination must not be the same tenant**: use separate app registrations; mapping pairs use object IDs from each tenant respectively.
- **429 / 503**: Graph throttling — retries exist; run off-peak for large jobs.
